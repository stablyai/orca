import { describe, expect, it, vi } from 'vitest'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { electronMocks } from '../orca-runtime-test-mocks/setup.spec'
import type {
  SleepingAgentSessionRecord,
  TerminalLaunchResult
} from '../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  HEADLESS_LEAF_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from './orca-runtime-test-fixtures.spec'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { PtyProcessInfo } from '../../providers/pty/process-info'
import { deterministicAgentSessionUuid } from '../terminal/launch/runtime-agent-launch-resolution'
import { deriveRemoteRuntimeTerminalCreateHandle } from '../terminal/identity/remote-runtime-terminal-create-identity'
import type { RuntimePtyController } from '../terminal/lifecycle/runtime-pty-controller-contract'
import { savedResumeResult } from '../../ipc/pty/host-env/saved-resume-admission'
import { spawnedCommands, resumeSpawns } from './agent-resume-spawn-commands.test-fixture'

const PANE_KEY = `host-tab:${HEADLESS_LEAF_ID}`
const SESSION = { key: 'session_id', id: 'provider-session-1' } as const
const MUTATION_ID = '["dev","thread-1","delivery-1"]'

function makeSleptWorkspace() {
  const record: SleepingAgentSessionRecord = {
    paneKey: PANE_KEY,
    tabId: 'host-tab',
    worktreeId: TEST_WORKTREE_ID,
    agent: 'claude',
    providerSession: SESSION,
    prompt: 'do the thing',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'worktree-sleep',
    launchConfig: { agentArgs: '--permission-mode plan', agentEnv: {} }
  }
  return makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      sleepingAgentSessionsByPaneKey: { [PANE_KEY]: record }
    })
  )
}

type Fixture = ReturnType<typeof makeSleptWorkspace>

function sessionRow(paneKey: string, receivedAt = 0): AgentStatusIpcPayload {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resume guards read only paneKey, providerSession and the observation clocks.
  return { paneKey, providerSession: SESSION, receivedAt } as never
}

async function makeRuntime(
  fixture: Fixture,
  opts: {
    spawn?: NonNullable<RuntimePtyController['spawn']>
    rows?: () => AgentStatusIpcPayload[]
    checkHookAgentPresence?: () => Promise<'live' | 'unverifiable' | 'exited' | null>
    listProcesses?: () => Promise<PtyProcessInfo[]>
    subscribeAgentProviderSessionChanges?: (
      listener: (sessions: readonly { paneKey: string; sessionId: string }[]) => void
    ) => () => void
  } = {}
) {
  const spawn = vi.fn<NonNullable<RuntimePtyController['spawn']>>(
    opts.spawn ?? (() => Promise.resolve({ id: 'resumed-pty' }))
  )
  const runtime = new OrcaRuntimeService(fixture.runtimeStore, undefined, {
    getDesktopWindowStatus: () => 'openable',
    ...(opts.rows ? { getAgentProviderSessionSnapshot: opts.rows } : {}),
    ...(opts.checkHookAgentPresence ? { checkHookAgentPresence: opts.checkHookAgentPresence } : {}),
    ...(opts.subscribeAgentProviderSessionChanges
      ? { subscribeAgentProviderSessionChanges: opts.subscribeAgentProviderSessionChanges }
      : {})
  })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: opts.listProcesses ?? (async () => [])
  })
  await runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  electronMocks.BrowserWindow.fromId.mockReturnValue(null)
  const attachWindow = (webContents?: { send: (...args: unknown[]) => void }): void => {
    runtime.attachWindow(TEST_WINDOW_ID)
    runtime.markGraphReady(TEST_WINDOW_ID)
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      ...(webContents ? { webContents } : {})
    })
  }
  const resume = (
    overrides: {
      captureHostId?: 'local' | `ssh:${string}`
      mutationId?: string
      signal?: AbortSignal
    } = {}
  ) =>
    runtime.resumeAgentSessionInWorkspace(TEST_WORKTREE_ID, {
      agent: 'claude',
      providerSession: SESSION,
      captureHostId: overrides.captureHostId ?? 'local',
      mutationId: overrides.mutationId ?? MUTATION_ID,
      signal: overrides.signal
    })
  const openOldPane = () =>
    runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', HEADLESS_LEAF_ID, {
      notifyClients: false,
      navigation: 'caller',
      intent: 'user'
    })
  return { runtime, spawn, attachWindow, resume, openOldPane }
}

function storedRecord(fixture: Fixture) {
  return fixture.getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]
}

describe('resumeAgentSessionInWorkspace', () => {
  it('settles only fresh matching saved results and binds unproven or observed results until exit', async () => {
    for (const kind of [
      'matching',
      'unverifiable',
      'observed',
      'other-session',
      'other-agent',
      'missing',
      'contradictory',
      'unknown'
    ]) {
      const fixture = makeSleptWorkspace()
      const record = storedRecord(fixture)!
      record.origin = 'live'
      const matching: TerminalLaunchResult = savedResumeResult({
        verdict: kind === 'unverifiable' ? 'unverifiable' : 'chat-home',
        refused: { agent: 'claude', providerSession: SESSION }
      })
      if (!matching.savedResumeDecision) {
        throw new Error('Saved admission must return its decision')
      }
      const receipt =
        kind === 'unknown'
          ? {}
          : {
              ...matching,
              savedResumeDecision:
                kind === 'missing'
                  ? undefined
                  : {
                      ...matching.savedResumeDecision,
                      agent: kind === 'other-agent' ? 'codex' : 'claude',
                      providerSession: kind === 'other-session' ? { ...SESSION, id: 'D' } : SESSION,
                      verdict:
                        kind === 'contradictory'
                          ? ('admitted' as const)
                          : matching.savedResumeDecision.verdict
                    },
              ...(kind === 'observed' ? { isReattach: true } : {})
            }
      let first = true
      const { runtime, spawn, openOldPane, resume } = await makeRuntime(fixture, {
        spawn: async (args) => {
          if (!first) {
            return { id: 'next-C' }
          }
          first = false
          expect(args).toMatchObject({
            launchAgent: 'claude',
            resumeOrigin: 'saved',
            resumeProviderSession: SESSION
          })
          return { id: 'result-pty', ...receipt }
        }
      })
      await openOldPane()
      const proved = kind === 'matching' || kind === 'unverifiable'
      const action = { mutationId: `after-${kind}` }
      if (!proved) {
        await expect(resume(action)).resolves.toEqual({ ok: false, reason: 'held_elsewhere' })
        expect(spawn).toHaveBeenCalledOnce()
        runtime.onPtyExit('result-pty', 0)
      }
      await expect(resume(action)).resolves.toMatchObject({ ok: true, ptyId: 'next-C' })
      expect(spawn).toHaveBeenCalledTimes(2)
    }
  })

  it('retains ownership after an ambiguous create with a running resume', async () => {
    const fixture = makeSleptWorkspace()
    const handle = deriveRemoteRuntimeTerminalCreateHandle(
      'agent-session-resume',
      TEST_WORKTREE_ID,
      MUTATION_ID
    )
    let started = false
    const { spawn, resume, attachWindow } = await makeRuntime(fixture, {
      rows: () => [],
      spawn: () => {
        started = true
        return Promise.reject(new Error('spawn reply lost'))
      },
      listProcesses: async () =>
        started
          ? [
              {
                id: 'resumed-pty',
                cwd: '',
                title: 'claude',
                terminalHandle: handle,
                worktreeId: TEST_WORKTREE_ID
              }
            ]
          : []
    })
    const record = storedRecord(fixture)
    if (record) {
      record.state = 'done'
    }
    const send = vi.fn()
    attachWindow({ send })

    await expect(resume()).resolves.toEqual({ ok: false, reason: 'create_failed' })
    await expect(resume({ mutationId: 'another-delivery' })).resolves.toEqual({
      ok: false,
      reason: 'held_elsewhere'
    })
    await expect(resume()).resolves.toMatchObject({ ok: true, ptyId: 'resumed-pty' })
    expect(spawn).toHaveBeenCalledOnce()
    // An attached window must not change the runtime the resume command was quoted for.
    expect(spawn.mock.calls[0]?.[0]).toHaveProperty('launchRuntime')
    expect(send).not.toHaveBeenCalledWith('terminal:requestTabCreate', expect.anything())
  })

  it.each(['resume', 'old pane'] as const)(
    'refuses the other resumer while the %s spawn is in flight',
    async (first) => {
      const fixture = makeSleptWorkspace()
      let landFirstSpawn = (): void => {}
      let firstSpawnStarted = (): void => {}
      const started = new Promise<void>((resolve) => {
        firstSpawnStarted = resolve
      })
      const { spawn, resume, openOldPane } = await makeRuntime(fixture, {
        spawn: () => {
          if (spawn.mock.calls.length > 1) {
            return Promise.resolve({ id: 'second-pty' })
          }
          firstSpawnStarted()
          return new Promise((resolve) => {
            landFirstSpawn = () => resolve({ id: 'resumed-pty' })
          })
        }
      })

      if (first === 'resume') {
        const resumed = resume()
        await started
        await openOldPane()
        landFirstSpawn()
        await expect(resumed).resolves.toMatchObject({ ok: true })
        expect(spawnedCommands(spawn)[1]).toBe('')
      } else {
        const opened = openOldPane()
        await started
        await expect(resume()).resolves.toEqual({ ok: false, reason: 'held_elsewhere' })
        landFirstSpawn()
        await opened
      }
      expect(resumeSpawns(spawn)).toBe(1)
    }
  )

  it('frees the session once the resumed agent reported, though it then exited to its shell', async () => {
    const fixture = makeSleptWorkspace()
    let rows: AgentStatusIpcPayload[] = []
    const listeners = new Set<
      (sessions: readonly { paneKey: string; sessionId: string }[]) => void
    >()
    const { spawn, resume } = await makeRuntime(fixture, {
      rows: () => rows,
      subscribeAgentProviderSessionChanges: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    })
    const first = await resume()
    if (!first.ok) {
      throw new Error(first.reason)
    }
    rows = [sessionRow(first.paneKey, Date.now())]
    listeners.forEach((listener) => listener([]))
    rows = []

    await expect(resume({ mutationId: 'after-exit' })).resolves.toMatchObject({ ok: true })
    expect(resumeSpawns(spawn)).toBe(2)
  })

  it('settles a lost-reply attempt once a retry of the same request binds, and frees on its exit', async () => {
    let calls = 0
    const { runtime, resume } = await makeRuntime(makeSleptWorkspace(), {
      rows: () => [],
      spawn: async () => {
        calls += 1
        if (calls === 1) {
          throw new Error('lost reply')
        }
        return { id: 'retried-pty' }
      }
    })
    await expect(resume()).resolves.toMatchObject({ ok: false })
    await expect(resume()).resolves.toMatchObject({ ok: true })
    await expect(resume({ mutationId: 'next' })).resolves.toEqual({
      ok: false,
      reason: 'held_elsewhere'
    })

    runtime.onPtyExit('retried-pty', 0)

    await expect(resume({ mutationId: 'next' })).resolves.toMatchObject({ ok: true })
  })

  it('lets at most one of two concurrent resumes own the session', async () => {
    const fixture = makeSleptWorkspace()
    const { spawn, resume } = await makeRuntime(fixture)

    const results = await Promise.all([resume(), resume({ mutationId: 'another-delivery' })])

    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results).toContainEqual({ ok: false, reason: 'held_elsewhere' })
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('shares one spawn between concurrent retries of the same request', async () => {
    const fixture = makeSleptWorkspace()
    const { spawn, resume } = await makeRuntime(fixture)

    const results = await Promise.all([resume(), resume()])

    expect(results.every((result) => result.ok)).toBe(true)
    expect(spawn).toHaveBeenCalledOnce()
  })
})

describe('resumeAgentSessionInWorkspace retries, cancellation and a failed publication', () => {
  it('honors cancellation during create inventory lookup before dispatch', async () => {
    const controller = new AbortController()
    const { resume, spawn } = await makeRuntime(makeSleptWorkspace(), {
      listProcesses: async () => {
        controller.abort()
        return []
      }
    })
    await expect(resume({ signal: controller.signal })).resolves.toMatchObject({ ok: false })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('settles a failed post-spawn publication when that PTY exits', async () => {
    const { runtime, resume } = await makeRuntime(makeSleptWorkspace())
    const unsubscribe = runtime.onMobileSessionTabsChanged(() => {
      throw new Error('publication failed')
    })
    await expect(resume()).resolves.toEqual({ ok: false, reason: 'create_failed' })
    unsubscribe()
    runtime.onPtyExit('resumed-pty', 0)
    await expect(resume({ mutationId: 'next-delivery' })).resolves.toMatchObject({ ok: true })
  })
})

describe('resumeAgentSessionInWorkspace claim lifetime', () => {
  it('releases the hold after a proven exit before registration', async () => {
    let first = true
    const { runtime, resume } = await makeRuntime(makeSleptWorkspace(), {
      spawn: async () => {
        if (first) {
          first = false
          runtime.beginPtyRegistration('resumed-pty')
          runtime.onPtyExit('resumed-pty', 0)
        }
        return { id: 'resumed-pty' }
      }
    })
    await expect(resume()).resolves.toEqual({ ok: false, reason: 'create_failed' })
    await expect(resume({ mutationId: 'after-proven-exit' })).resolves.toMatchObject({ ok: true })
  })

  it('does not settle a lost reply using another caller terminal in the same pane', async () => {
    let rejectFirst!: (error: Error) => void
    let started!: () => void
    const start = new Promise<void>((resolve) => {
      started = resolve
    })
    let calls = 0
    const { runtime, resume, spawn } = await makeRuntime(makeSleptWorkspace(), {
      spawn: async () => {
        calls += 1
        if (calls === 1) {
          started()
          return new Promise<{ id: string }>((_resolve, reject) => {
            rejectFirst = reject
          })
        }
        return { id: `other-pty-${calls}` }
      }
    })
    const first = resume()
    await start
    const args = spawn.mock.calls[0]?.[0]
    if (
      !args ||
      typeof args !== 'object' ||
      !('tabId' in args) ||
      !('leafId' in args) ||
      typeof args.tabId !== 'string' ||
      typeof args.leafId !== 'string'
    ) {
      throw new Error('missing pane identity')
    }
    const other = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      tabId: args.tabId,
      leafId: args.leafId,
      command: 'echo another caller',
      focus: false
    })
    rejectFirst(new Error('lost spawn reply'))
    await expect(first).resolves.toEqual({ ok: false, reason: 'create_failed' })
    if (!other.ptyId) {
      throw new Error('missing other PTY')
    }
    runtime.onPtyExit(other.ptyId, 0)
    await expect(resume({ mutationId: 'other-delivery' })).resolves.toEqual({
      ok: false,
      reason: 'held_elsewhere'
    })
  })

  it('does not settle an ambiguous resume using an earlier exited shell in its pane', async () => {
    const seed = `${TEST_WORKTREE_ID}\0${MUTATION_ID}`
    const tabId = deterministicAgentSessionUuid(`agent-session-resume-tab\0${seed}`)
    const leafId = deterministicAgentSessionUuid(`agent-session-resume-leaf\0${seed}`)
    let firstInventory = true
    let spawns = 0
    const { runtime, resume } = await makeRuntime(makeSleptWorkspace(), {
      listProcesses: async () => {
        if (firstInventory) {
          firstInventory = false
          const other = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
            tabId,
            leafId,
            command: 'echo another caller',
            focus: false
          })
          if (!other.ptyId) {
            throw new Error('missing shell PTY')
          }
          runtime.onPtyExit(other.ptyId, 0)
        }
        return []
      },
      spawn: async () => {
        spawns += 1
        if (spawns === 2) {
          throw new Error('resume started but reply lost')
        }
        return { id: `sequential-pty-${spawns}` }
      }
    })
    await expect(resume()).resolves.toEqual({ ok: false, reason: 'create_failed' })
    await expect(resume({ mutationId: 'next-delivery' })).resolves.toEqual({
      ok: false,
      reason: 'held_elsewhere'
    })
  })
})

it.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
  'hands a numbered-record resume claim to the stable pane hook',
  async () => {
    const fixture = makeSleptWorkspace()
    const record = storedRecord(fixture)
    if (!record) {
      throw new Error('missing sleep record')
    }
    fixture.setSession({
      ...fixture.getSession(),
      sleepingAgentSessionsByPaneKey: {
        'host-tab:1': { ...record, paneKey: 'host-tab:1', state: 'done' }
      }
    })
    let rows: AgentStatusIpcPayload[] = []
    let spawned = 0
    const { resume, openOldPane, spawn } = await makeRuntime(fixture, {
      rows: () => rows,
      checkHookAgentPresence: async () => 'exited',
      spawn: async () => ({ id: `numbered-resume-${++spawned}` })
    })
    await openOldPane()
    expect(resumeSpawns(spawn)).toBe(1)
    rows = [sessionRow(PANE_KEY, Date.now() + 1)]
    await expect(resume()).resolves.toMatchObject({ ok: true })
  }
)
