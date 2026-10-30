import { expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import { DaemonPtyRouter } from '../daemon/daemon-pty-router'
import { DegradedDaemonPtyProvider } from '../daemon/degraded-daemon-pty-provider'
import { LocalPtyProvider } from '../providers/local-pty-provider'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from '../daemon/daemon-pty-adapter-test-harness'
import type { IPtyProvider } from '../providers/pty-provider-contract'
import { PtyWriteUnavailableError } from '../providers/pty-write-unavailable-error'

await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-test-fixtures.spec')

const providerSession = { key: 'session_id' as const, id: 'codex-conversation' }

function mobileChat(provider: IPtyProvider) {
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal()
  )
  const runtime = new OrcaRuntimeService(runtimeStore)
  const spawn = vi.fn()
  const write = vi.fn(() => true)
  runtime.setPtyController({
    spawn,
    write,
    kill: () => true,
    getForegroundProcess: async () => null,
    hasPty: (id) => provider.hasPty?.(id) ?? null,
    getPtyAvailability: (id) => provider.getPtyAvailability?.(id) ?? null,
    listProcesses: () => provider.listProcesses()
  })
  runtime.attachWindow(1)
  let snapshotVersion = 0
  const publish = (ptyId: string) =>
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex',
          activeLeafId: HEADLESS_LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'host-tab',
          worktreeId: TEST_WORKTREE_ID,
          leafId: HEADLESS_LEAF_ID,
          paneRuntimeId: 1,
          ptyId,
          paneTitle: 'Codex'
        }
      ],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer',
          snapshotVersion: ++snapshotVersion,
          activeGroupId: null,
          activeTabId: 'host-tab',
          activeTabType: 'terminal',
          tabs: [
            {
              type: 'terminal',
              id: `host-tab::${HEADLESS_LEAF_ID}`,
              parentTabId: 'host-tab',
              leafId: HEADLESS_LEAF_ID,
              ptyId,
              title: 'Codex',
              isActive: true,
              agentStatus: {
                agentType: 'codex',
                state: 'waiting',
                prompt: '',
                updatedAt: 1,
                stateStartedAt: 1,
                stateHistory: [],
                paneKey: `host-tab:${HEADLESS_LEAF_ID}`,
                providerSession
              }
            }
          ]
        }
      ]
    })
  const read = () => runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
  const published = () => runtime['getMobileSessionTabsForWorktree'](TEST_WORKTREE_ID)
  return { runtime, publish, read, published, spawn, write }
}

it.each(['direct', 'router', 'degraded'] as const)(
  'keeps an unattached retained conversation ready, then withholds a gone PTY through %s',
  async (route) => {
    const subprocesses: ReturnType<typeof createMockSubprocess>[] = []
    const harness = await startDaemonAdapterHarness(() => {
      const subprocess = createMockSubprocess()
      subprocesses.push(subprocess)
      return subprocess
    })
    const owner = new DaemonPtyAdapter(harness)
    try {
      await harness.adapter.spawn({
        sessionId: 'persisted-pty',
        cwd: TEST_WORKTREE_PATH,
        cols: 80,
        rows: 24
      })
      harness.adapter.dispose()
      const provider =
        route === 'direct'
          ? owner
          : route === 'router'
            ? new DaemonPtyRouter({ current: owner, legacy: [] })
            : new DegradedDaemonPtyProvider({
                current: owner,
                legacy: [],
                fallback: new LocalPtyProvider()
              })
      const chat = mobileChat(provider)
      chat.publish('persisted-pty')
      const before = await chat.read()
      expect(owner.hasPty('persisted-pty')).toBe(false)
      expect(before.tabs[0]).toMatchObject({ status: 'ready', terminal: expect.any(String) })
      const original = before.tabs[0]
      if (original?.type !== 'terminal') {
        throw new Error('Expected the retained terminal')
      }

      await owner.attach('persisted-pty')
      expect((await chat.read()).tabs[0]).toHaveProperty('terminal', original.terminal)
      expect(subprocesses).toHaveLength(1)
      subprocesses[0]?._simulateExit(0)
      await waitFor(() => !owner.hasPty('persisted-pty'))
      expect((await chat.read()).tabs[0]).toMatchObject({
        status: 'pending-handle',
        terminal: null
      })
      chat.publish('persisted-pty')
      expect(chat.published().tabs[0]).toMatchObject({ status: 'pending-handle', terminal: null })

      await owner.spawn({
        sessionId: 'replacement-pty',
        cwd: TEST_WORKTREE_PATH,
        cols: 80,
        rows: 24
      })
      chat.publish('replacement-pty')
      const restored = (await chat.read()).tabs[0]
      expect(restored).toMatchObject({
        id: original.id,
        status: 'ready',
        terminal: expect.any(String),
        agentStatus: expect.objectContaining({ providerSession })
      })
      expect(restored).not.toHaveProperty('terminal', original.terminal)
      expect(chat.spawn).not.toHaveBeenCalled()
      expect(chat.write).not.toHaveBeenCalled()
      expect(subprocesses.every((subprocess) => subprocess.write.mock.calls.length === 0)).toBe(
        true
      )
    } finally {
      owner.dispose()
      harness.adapter.dispose()
      await harness.server.shutdown()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  }
)

it('withholds an attached PTY during endpoint recovery and restores its same conversation without replay', async () => {
  const subprocess = createMockSubprocess()
  const harness = await startDaemonAdapterHarness(() => subprocess)
  const respawn = vi.fn(async () => {})
  const owner = new DaemonPtyAdapter({ ...harness, respawn })
  try {
    await owner.spawn({ sessionId: 'persisted-pty', cwd: TEST_WORKTREE_PATH, cols: 80, rows: 24 })
    const chat = mobileChat(owner)
    chat.publish('persisted-pty')
    const original = (await chat.read()).tabs[0]
    if (original?.type !== 'terminal') {
      throw new Error('Expected the attached terminal')
    }
    expect(original.status).toBe('ready')
    const unavailable = new Promise<void>((resolve) => owner.onWriteUnavailable(() => resolve()))
    owner['client'].disconnect()
    expect(() => owner.write('persisted-pty', 'refused')).toThrow(PtyWriteUnavailableError)
    await unavailable
    expect(owner.hasPty('persisted-pty')).toBe(true)
    expect(chat.published().tabs[0]).toMatchObject({ status: 'pending-handle', terminal: null })

    // Successful inventory reconnects transport but does not clear the remount fence.
    expect((await chat.read()).tabs[0]).toMatchObject({ status: 'pending-handle', terminal: null })
    await owner.attach('persisted-pty')
    expect((await chat.read()).tabs[0]).toMatchObject({
      id: original.id,
      status: 'ready',
      terminal: original.terminal,
      agentStatus: expect.objectContaining({ providerSession })
    })
    expect(subprocess.write).not.toHaveBeenCalled()
    expect(chat.spawn).not.toHaveBeenCalled()
    expect(chat.write).not.toHaveBeenCalled()
    expect(respawn).not.toHaveBeenCalled()

    respawn.mockRejectedValue(new Error('daemon remains unavailable'))
    await harness.server.shutdown()
    await waitFor(() => owner.getDaemonIdentity() === null)
    expect((await chat.read()).tabs[0]).toMatchObject({ status: 'pending-handle', terminal: null })
    expect(owner.hasPty('persisted-pty')).toBe(true)
    expect(subprocess.write).not.toHaveBeenCalled()
    expect(chat.spawn).not.toHaveBeenCalled()
  } finally {
    owner.dispose()
    harness.adapter.dispose()
    await harness.server.shutdown()
    rmSync(harness.dir, { recursive: true, force: true })
  }
})
