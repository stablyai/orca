import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { Store } from '../loading-store/store'
import { WindowSession } from './terminal-topology-window-session-fixture'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStore,
  reopenTopologyStore
} from './terminal-topology-profile-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const WORKTREE = FIXTURE_GIT_WORKTREE_ID
const TAB = 'tab-1'
const LEFT = '11111111-1111-4111-8111-111111111111'
const RIGHT = '22222222-2222-4222-8222-222222222222'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function record(leafId: string, id: string): SleepingAgentSessionRecord {
  return {
    paneKey: `${TAB}:${leafId}`,
    tabId: TAB,
    worktreeId: WORKTREE,
    agent: 'codex',
    providerSession: { key: 'session_id', id },
    prompt: 'finish the task',
    state: 'done',
    capturedAt: 2,
    updatedAt: 1,
    origin: 'worktree-sleep'
  }
}

async function storeWithSplitTab(hostId?: string): Promise<{ store: Store; directory: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'orca-layout-sleep-'))
  directories.push(directory)
  const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
  const window = new WindowSession(getDefaultWorkspaceSession())
  window.addTab(WORKTREE, TAB, LEFT)
  window.setLayout(
    TAB,
    {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEFT },
      second: { type: 'leaf', leafId: RIGHT }
    },
    { [LEFT]: 'pty-left', [RIGHT]: 'pty-right' }
  )
  window.setSleeping({ [`${TAB}:${RIGHT}`]: record(RIGHT, 'right-session') })
  store.setWorkspaceSession(window.snapshot(), hostId)
  await store.flushPendingOrThrowAsync()
  return { store, directory }
}

describe('Store.applyLayoutCommand sleep and wake (layout.apply)', () => {
  it('records a pane’s sleep durably and keeps its pane and binding', async () => {
    const { store, directory } = await storeWithSplitTab()
    const left = record(LEFT, 'left-session')

    const reply = await store.applyLayoutCommand({
      type: 'sleep',
      workspace: WORKTREE,
      paneKeys: [left.paneKey],
      records: [left]
    })

    expect(reply).toEqual({ ok: true, result: { slept: [left.paneKey] } })
    const session = (await reopenTopologyStore(store, directory)).getWorkspaceSession()
    expect(session.sleepingAgentSessionsByPaneKey).toEqual({
      [left.paneKey]: left,
      [`${TAB}:${RIGHT}`]: record(RIGHT, 'right-session')
    })
    expect(session.terminalLayoutsByTabId[TAB]?.ptyIdsByLeafId).toEqual({
      [LEFT]: 'pty-left',
      [RIGHT]: 'pty-right'
    })
  })

  it('a record-only wake drops only the named pane’s record', async () => {
    const { store, directory } = await storeWithSplitTab()
    const left = record(LEFT, 'left-session')
    await store.applyLayoutCommand({
      type: 'sleep',
      workspace: WORKTREE,
      paneKeys: [left.paneKey],
      records: [left]
    })

    const reply = await store.applyLayoutCommand({
      type: 'wake',
      workspace: WORKTREE,
      paneKeys: [left.paneKey],
      recordOnly: true
    })

    expect(reply).toEqual({ ok: true, result: { woken: [left.paneKey] } })
    const session = (await reopenTopologyStore(store, directory)).getWorkspaceSession()
    expect(session.sleepingAgentSessionsByPaneKey).toEqual({
      [`${TAB}:${RIGHT}`]: record(RIGHT, 'right-session')
    })
  })

  it('a wake starts the pane and keeps its record, which the start resumes from', async () => {
    const { store } = await storeWithSplitTab()
    const left = record(LEFT, 'left-session')
    await store.applyLayoutCommand({
      type: 'sleep',
      workspace: WORKTREE,
      paneKeys: [left.paneKey],
      records: [left]
    })
    const onEffects = vi.fn()

    const reply = await store.applyLayoutCommand(
      { type: 'wake', workspace: WORKTREE, paneKeys: [left.paneKey] },
      [],
      { onEffects }
    )

    expect(reply).toEqual({ ok: true, result: { woken: [left.paneKey] } })
    expect(onEffects).toHaveBeenCalledWith({ stopPtyIds: [], startPaneKeys: [left.paneKey] })
    expect(store.getWorkspaceSession().sleepingAgentSessionsByPaneKey?.[left.paneKey]).toEqual(left)
  })

  it('wakes nothing for a pane that holds no record', async () => {
    const { store } = await storeWithSplitTab()
    const before = store.getWorkspaceSession()

    const reply = await store.applyLayoutCommand({
      type: 'wake',
      workspace: WORKTREE,
      paneKeys: [`${TAB}:${LEFT}`]
    })

    expect(reply).toEqual({ ok: true, result: { woken: [] } })
    expect(store.getWorkspaceSession()).toBe(before)
  })

  it('records an SSH workspace’s sleep in that host’s partition only', async () => {
    const { store } = await storeWithSplitTab('ssh:target-1')
    const left = record(LEFT, 'left-session')

    await store.applyLayoutCommand(
      { type: 'sleep', workspace: WORKTREE, paneKeys: [left.paneKey], records: [left] },
      ['ssh:target-1']
    )

    expect(
      store.getWorkspaceSession('ssh:target-1').sleepingAgentSessionsByPaneKey?.[left.paneKey]
    ).toEqual(left)
    expect(store.getWorkspaceSession().sleepingAgentSessionsByPaneKey).toBeUndefined()
  })
})

describe('Store.applyLayoutCommand restartPane (layout.apply)', () => {
  const restart = { type: 'restartPane', workspace: WORKTREE, paneKey: `${TAB}:${LEFT}` } as const

  it('stops the pane’s terminal before it writes the pane unbound, then starts it', async () => {
    const { store, directory } = await storeWithSplitTab()
    const order: string[] = []
    const stopBeforeWrite = vi.fn(() => {
      order.push(
        `stop, bound to ${store.getWorkspaceSession().terminalLayoutsByTabId[TAB]?.ptyIdsByLeafId?.[LEFT]}`
      )
      return true
    })
    const onEffects = vi.fn(() => order.push('start'))

    const reply = await store.applyLayoutCommand(restart, [], { stopBeforeWrite, onEffects })

    expect(reply).toMatchObject({ ok: true })
    expect(stopBeforeWrite).toHaveBeenCalledWith(['pty-left'])
    expect(order).toEqual(['stop, bound to pty-left', 'start'])
    const session = (await reopenTopologyStore(store, directory)).getWorkspaceSession()
    expect(session.terminalLayoutsByTabId[TAB]?.ptyIdsByLeafId?.[LEFT]).toBeUndefined()
  })

  it('keeps the pane bound and starts nothing when its terminal would not stop', async () => {
    const { store, directory } = await storeWithSplitTab()
    const onEffects = vi.fn()

    const reply = await store.applyLayoutCommand(restart, [], {
      stopBeforeWrite: () => false,
      onEffects
    })

    expect(reply).toEqual({ ok: false, code: 'pane_already_bound' })
    expect(onEffects).not.toHaveBeenCalled()
    const session = (await reopenTopologyStore(store, directory)).getWorkspaceSession()
    expect(session.terminalLayoutsByTabId[TAB]?.ptyIdsByLeafId).toEqual({
      [LEFT]: 'pty-left',
      [RIGHT]: 'pty-right'
    })
  })
})
