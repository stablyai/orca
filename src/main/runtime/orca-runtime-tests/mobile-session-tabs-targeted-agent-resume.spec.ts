import { describe, expect, it, vi } from 'vitest'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { OrcaRuntimeService, electronMocks } from '../orca-runtime-test-mocks.spec'
import type { SleepingAgentSessionRecord } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../orca-runtime-test-fixtures.spec'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import type { TerminalLaunchResult } from '../../../shared/agent-session-resume'
import type { PtyProcessInfo } from '../../providers/pty-provider-contract'
import { deterministicAgentSessionUuid } from '../runtime-agent-launch-resolution'
import { deriveRemoteRuntimeTerminalCreateHandle } from '../remote-runtime-terminal-create-identity'
import type { RuntimePtyController } from '../runtime-pty-controller-contract'
import { AgentSessionRecordStore } from '../agent-session-record-store'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import {
  chooseSavedResumeFreshLaunch,
  savedResumeResult
} from '../../ipc/pty/host-env/saved-resume-admission'

const PANE_KEY = `host-tab:${HEADLESS_LEAF_ID}`
const SESSION = { key: 'session_id', id: 'provider-session-1' } as const
const MUTATION_ID = '["dev","thread-1","delivery-1"]'
const PANE_OWNED = { origin: 'worktree-sleep', state: 'done', restoreOnTabOpenOnly: true }

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

type DurableMutationStore = { runDurableMutation: (mutate: unknown) => Promise<unknown> }

function isDurableMutationStore(
  store: Fixture['runtimeStore']
): store is Fixture['runtimeStore'] & DurableMutationStore {
  return 'runDurableMutation' in store && typeof store.runDurableMutation === 'function'
}

type WorkspaceScopeResolver = {
  resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
}

function hasWorkspaceScopeResolver(
  runtime: OrcaRuntimeService
): runtime is OrcaRuntimeService & WorkspaceScopeResolver {
  return (
    'resolveTerminalWorkspaceLaunchScope' in runtime &&
    typeof runtime.resolveTerminalWorkspaceLaunchScope === 'function'
  )
}

function sessionRow(paneKey: string, receivedAt = 0): AgentStatusIpcPayload {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resume guards read only paneKey, providerSession and the observation clocks.
  return { paneKey, providerSession: SESSION, receivedAt } as never
}

function makeRuntime(
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
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
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

function spawnedCommands(spawn: ReturnType<typeof vi.fn>): string[] {
  return spawn.mock.calls.map(([args]: unknown[]) =>
    typeof args === 'object' && args !== null && 'command' in args ? String(args.command ?? '') : ''
  )
}

function resumeSpawns(spawn: ReturnType<typeof vi.fn>): number {
  return spawnedCommands(spawn).filter((command) => command.includes('provider-session-1')).length
}

function storedRecord(fixture: Fixture) {
  return fixture.getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]
}

describe('resumeAgentSessionInWorkspace', () => {
  it.each(['live', 'worktree-sleep'] as const)(
    'releases a %s saved resume claim when actual admission creates a plain shell',
    async (origin) => {
      const fixture = makeSleptWorkspace()
      const saved = storedRecord(fixture)
      if (!saved) {
        throw new Error('missing saved conversation')
      }
      saved.origin = origin
      const chat = agentSessionRecordFixture(
        agentSessionLeaseFixture({
          claimStatus: 'released',
          ownerProcess: null,
          reservedSpawnToken: null,
          deathEvidence: { kind: 'exit-observed', detail: 'closed', observedAt: 1 }
        })
      )
      chat.providerHandleChain[0]!.handle.nativeId = SESSION.id
      let nativeOpen = true
      const store: AgentSessionRecordStore = Object.create(AgentSessionRecordStore.prototype)
      store.listRecords = () => [chat]
      store.getVisibleSessionTabIndex = () => ({
        present: true,
        sessionIds: nativeOpen ? [chat.sessionId] : []
      })
      const effectiveCommands: (string | undefined)[] = []
      const { runtime, spawn, openOldPane, resume } = makeRuntime(fixture, {
        spawn: async (args) => {
          const admission = await chooseSavedResumeFreshLaunch(
            { openAgentSessionRecordStore: async () => store },
            args,
            null,
            args
          )
          effectiveCommands.push(args.command)
          return {
            id: effectiveCommands.length === 1 ? 'refused-shell' : 'resumed-C',
            launchAgent: args.launchAgent,
            launchConfig: args.launchConfig,
            ...savedResumeResult(admission)
          }
        }
      })
      await openOldPane()
      expect(runtime.getTerminalLaunchResult('refused-shell')).toMatchObject({
        agentResumeRefused: 'chat-home',
        savedResumeDecision: { agent: 'claude', providerSession: SESSION, verdict: 'chat-home' }
      })
      expect(runtime.getTerminalLaunchResult('refused-shell')?.launchAgent).toBeUndefined()
      expect(effectiveCommands).toEqual([undefined])
      nativeOpen = false
      await expect(resume({ mutationId: 'after-native-close' })).resolves.toMatchObject({
        ok: true,
        ptyId: 'resumed-C'
      })
      expect(effectiveCommands[1]).toContain(SESSION.id)
      expect(spawn).toHaveBeenCalledTimes(2)
      expect(runtime.getTerminalLaunchResult('refused-shell')).toBeDefined()
    }
  )

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
      const { runtime, spawn, openOldPane, resume } = makeRuntime(fixture, {
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
    const { spawn, resume, attachWindow } = makeRuntime(fixture, {
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

  it('rechecks hook ownership when another resume settles during pane preflight', async () => {
    const fixture = makeSleptWorkspace()
    let rows: AgentStatusIpcPayload[] = []
    const { runtime, spawn, resume, openOldPane } = makeRuntime(fixture, {
      rows: () => rows,
      checkHookAgentPresence: async () => 'live'
    })
    if (!hasWorkspaceScopeResolver(runtime)) {
      throw new Error('missing resolver')
    }
    const resolveWorkspace = runtime.resolveTerminalWorkspaceLaunchScope.bind(runtime)
    let first = true
    Object.assign(runtime, {
      resolveTerminalWorkspaceLaunchScope: async (selector: string) => {
        if (first) {
          first = false
          const result = await resume()
          if (result.ok) {
            rows = [sessionRow(result.paneKey, Date.now() + 1)]
          }
        }
        return resolveWorkspace(selector)
      }
    })
    await openOldPane()
    expect(resumeSpawns(spawn)).toBe(1)
  })

  it('resumes the conversation in a fresh pane with its recorded flags and returns the binding', async () => {
    const fixture = makeSleptWorkspace()
    const { spawn, resume } = makeRuntime(fixture)

    const result = await resume()

    expect(result).toMatchObject({ ok: true, ptyId: 'resumed-pty' })
    expect(result.ok && result.paneKey).not.toBe(PANE_KEY)
    expect(spawn).toHaveBeenCalledOnce()
    const [command] = spawnedCommands(spawn)
    expect(command).toContain('--resume')
    expect(command).toContain('provider-session-1')
    expect(command).toMatch(/--permission-mode'? '?plan/)
    // The resume must spawn in the Windows/WSL runtime its command was quoted for.
    expect(spawn.mock.calls[0]?.[0]).toHaveProperty('launchRuntime')
    expect(storedRecord(fixture)).toMatchObject(PANE_OWNED)
  })

  it('resumes and claims the record with a window already attached', async () => {
    const fixture = makeSleptWorkspace()
    const { spawn, attachWindow, resume } = makeRuntime(fixture)
    attachWindow()

    await expect(resume()).resolves.toMatchObject({ ok: true, ptyId: 'resumed-pty' })
    expect(resumeSpawns(spawn)).toBe(1)
    expect(storedRecord(fixture)).toMatchObject(PANE_OWNED)
  })

  it('resumes when a window attaches while the workspace resolves', async () => {
    const fixture = makeSleptWorkspace()
    const { spawn, attachWindow, resume } = makeRuntime(fixture)

    const pending = resume()
    attachWindow()

    await expect(pending).resolves.toMatchObject({ ok: true })
    expect(resumeSpawns(spawn)).toBe(1)
    expect(storedRecord(fixture)).toMatchObject(PANE_OWNED)
  })

  it('resumes when a window attaches during the duplicate-holder check', async () => {
    const fixture = makeSleptWorkspace()
    let attach = (): void => {}
    const { spawn, attachWindow, resume } = makeRuntime(fixture, {
      rows: () => [sessionRow(`other-tab:${HEADLESS_SECOND_LEAF_ID}`)],
      checkHookAgentPresence: async () => {
        attach()
        return 'exited'
      }
    })
    attach = attachWindow

    await expect(resume()).resolves.toMatchObject({ ok: true })
    expect(resumeSpawns(spawn)).toBe(1)
  })

  it('resumes when a window attaches before the record claim commits', async () => {
    const fixture = makeSleptWorkspace()
    const { spawn, attachWindow, resume } = makeRuntime(fixture)
    const store = fixture.runtimeStore
    if (!isDurableMutationStore(store)) {
      throw new Error('fixture store is not durable')
    }
    const commit = store.runDurableMutation.bind(store)
    Object.assign(store, {
      runDurableMutation: (mutate: unknown) => {
        attachWindow()
        return commit(mutate)
      }
    })

    await expect(resume()).resolves.toMatchObject({ ok: true })
    expect(resumeSpawns(spawn)).toBe(1)
    expect(storedRecord(fixture)).toMatchObject(PANE_OWNED)
  })

  it('keeps the record pane-owned when a window attaches during the spawn', async () => {
    const fixture = makeSleptWorkspace()
    let attach = (): void => {}
    const { spawn, attachWindow, resume } = makeRuntime(fixture, {
      spawn: async () => {
        attach()
        return { id: 'resumed-pty' }
      }
    })
    attach = attachWindow

    await expect(resume()).resolves.toMatchObject({ ok: true })
    expect(resumeSpawns(spawn)).toBe(1)
    expect(storedRecord(fixture)).toMatchObject(PANE_OWNED)
  })

  it('lets only one of a resume and an old-pane open started together own the session', async () => {
    const fixture = makeSleptWorkspace()
    const { spawn, resume, openOldPane } = makeRuntime(fixture)

    const [resumed] = await Promise.allSettled([resume(), openOldPane()])

    expect(resumeSpawns(spawn)).toBe(1)
    expect(spawnedCommands(spawn)).toContain('')
    expect(resumed.status).toBe('fulfilled')
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
      const { spawn, resume, openOldPane } = makeRuntime(fixture, {
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

  // Before its first hook, only the claim identifies the SSH session holder.
  it('keeps the old pane from resuming before the resumed agent reports a hook', async () => {
    const fixture = makeSleptWorkspace()
    const { spawn, resume, openOldPane } = makeRuntime(fixture, { rows: () => [] })

    await expect(resume()).resolves.toMatchObject({ ok: true })
    await openOldPane()

    expect(resumeSpawns(spawn)).toBe(1)
    expect(spawnedCommands(spawn)[1]).toBe('')
  })

  it.each([
    ['live', 1],
    ['exited', 2]
  ] as const)(
    'hands the session to the hook-store guard once the resumed pane reports it (%s)',
    async (presence, expectedResumes) => {
      const fixture = makeSleptWorkspace()
      let rows: AgentStatusIpcPayload[] = []
      const { spawn, resume, openOldPane } = makeRuntime(fixture, {
        rows: () => rows,
        checkHookAgentPresence: async () => presence
      })
      const result = await resume()
      if (!result.ok) {
        throw new Error(result.reason)
      }
      rows = [sessionRow(result.paneKey, Date.now())]

      await openOldPane()
      expect(resumeSpawns(spawn)).toBe(expectedResumes)
    }
  )

  it('frees the session once the resumed agent reported, though it then exited to its shell', async () => {
    const fixture = makeSleptWorkspace()
    let rows: AgentStatusIpcPayload[] = []
    const listeners = new Set<
      (sessions: readonly { paneKey: string; sessionId: string }[]) => void
    >()
    const { spawn, resume } = makeRuntime(fixture, {
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
    const { runtime, resume } = makeRuntime(makeSleptWorkspace(), {
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
    const { spawn, resume } = makeRuntime(fixture)

    const results = await Promise.all([resume(), resume({ mutationId: 'another-delivery' })])

    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results).toContainEqual({ ok: false, reason: 'held_elsewhere' })
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('shares one spawn between concurrent retries of the same request', async () => {
    const fixture = makeSleptWorkspace()
    const { spawn, resume } = makeRuntime(fixture)

    const results = await Promise.all([resume(), resume()])

    expect(results.every((result) => result.ok)).toBe(true)
    expect(spawn).toHaveBeenCalledOnce()
  })

  // An unreachable SSH host does not prove the agent exited.
  it.each([
    ['unverifiable', false],
    ['live', false],
    [null, false],
    ['exited', true]
  ] as const)(
    'resumes past an old pane naming the session only on a proven exit (%s)',
    async (presence, resumes) => {
      const fixture = makeSleptWorkspace()
      const { spawn, resume } = makeRuntime(fixture, {
        rows: () => [sessionRow(PANE_KEY)],
        checkHookAgentPresence: async () => presence
      })

      const result = await resume()

      expect(result.ok).toBe(resumes)
      expect(resumeSpawns(spawn)).toBe(resumes ? 1 : 0)
    }
  )

  it('refuses a session captured on another host without spawning', async () => {
    const fixture = makeSleptWorkspace()
    const { spawn, resume } = makeRuntime(fixture)

    await expect(resume({ captureHostId: 'ssh:other-box' })).resolves.toEqual({
      ok: false,
      reason: 'no_resume_command'
    })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('refuses an aborted request without spawning', async () => {
    const fixture = makeSleptWorkspace()
    const { spawn, resume } = makeRuntime(fixture)
    const controller = new AbortController()
    controller.abort()

    await expect(resume({ signal: controller.signal })).resolves.toEqual({
      ok: false,
      reason: 'aborted'
    })
    expect(spawn).not.toHaveBeenCalled()
  })

  it("reports a failed spawn, never a shell, and keeps the session for that request's retry", async () => {
    const fixture = makeSleptWorkspace()
    let fail = true
    const { spawn, resume } = makeRuntime(fixture, {
      spawn: async () => {
        if (fail) {
          throw new Error('spawn failed')
        }
        return { id: 'resumed-pty' }
      }
    })

    await expect(resume()).resolves.toEqual({ ok: false, reason: 'create_failed' })
    expect(spawnedCommands(spawn).every((command) => command.includes('provider-session-1'))).toBe(
      true
    )
    expect(storedRecord(fixture)).toMatchObject(PANE_OWNED)

    // An ambiguous dispatch remains owned by the same request's pane.
    await expect(resume({ mutationId: 'another-delivery' })).resolves.toEqual({
      ok: false,
      reason: 'held_elsewhere'
    })
    fail = false
    await expect(resume()).resolves.toMatchObject({ ok: true })
  })
})

describe('resumeAgentSessionInWorkspace retries, cancellation and a failed publication', () => {
  it('reconciles the same request after its own hook arrives', async () => {
    let rows: AgentStatusIpcPayload[] = []
    const terminalHandle = deriveRemoteRuntimeTerminalCreateHandle(
      'agent-session-resume',
      TEST_WORKTREE_ID,
      MUTATION_ID
    )
    const { resume, spawn } = makeRuntime(makeSleptWorkspace(), {
      rows: () => rows,
      checkHookAgentPresence: async () => 'live',
      listProcesses: async () =>
        spawn.mock.calls.length > 0
          ? [
              {
                id: 'resumed-pty',
                cwd: '',
                title: 'claude',
                terminalHandle,
                worktreeId: TEST_WORKTREE_ID
              }
            ]
          : []
    })
    const first = await resume()
    if (!first.ok) {
      throw new Error(first.reason)
    }
    rows = [sessionRow(first.paneKey, Date.now() + 1)]
    await expect(resume()).resolves.toEqual(first)
    expect(spawn).toHaveBeenCalledOnce()
  })

  it('honors cancellation during create inventory lookup before dispatch', async () => {
    const controller = new AbortController()
    const { resume, spawn } = makeRuntime(makeSleptWorkspace(), {
      listProcesses: async () => {
        controller.abort()
        return []
      }
    })
    await expect(resume({ signal: controller.signal })).resolves.toMatchObject({ ok: false })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('settles a failed post-spawn publication when that PTY exits', async () => {
    const { runtime, resume } = makeRuntime(makeSleptWorkspace())
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
    const { runtime, resume } = makeRuntime(makeSleptWorkspace(), {
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
    const { runtime, resume, spawn } = makeRuntime(makeSleptWorkspace(), {
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
    const { runtime, resume } = makeRuntime(makeSleptWorkspace(), {
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
    const { resume, openOldPane, spawn } = makeRuntime(fixture, {
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
