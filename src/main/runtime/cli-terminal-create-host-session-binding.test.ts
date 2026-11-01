/** Host creates need durable binding/runtime ownership to survive graph sync without a renderer writer. */
import { describe, expect, it, vi } from 'vitest'
import { ClaudeAgentTeamsService } from './claude-agent-teams-service'
import * as launchPlan from './terminal/launch/agent-teams-launch-plan'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import './rpc/unused-default-rpc-methods.test-fixture'
import {
  startDesktopMultiplexSubscribe,
  sendDesktopMultiplexSubscribe
} from './rpc/terminal-multiplex-test-harness'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText
} from '../../shared/terminal-stream-protocol'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => ({ isDestroyed: () => false })) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

function createRuntimeWithAttachedWindow() {
  const runtime = new OrcaRuntimeService()
  vi.spyOn(
    runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<unknown>
    },
    'resolveTerminalWorkspaceLaunchScope'
  ).mockResolvedValue({
    id: 'repo-1::/tmp/wt-cli',
    path: '/tmp/wt-cli',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  const spawn = vi
    .fn<NonNullable<RuntimePtyController['spawn']>>()
    .mockResolvedValue({ id: 'repo-1::/tmp/wt-cli@@a1b2c3d4' })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  } as never)
  runtime.attachWindow(1)
  return { runtime, spawn }
}

describe('host-initiated terminal creation under an attached window', () => {
  it('persists the host session binding at spawn', async () => {
    const { runtime, spawn } = createRuntimeWithAttachedWindow()

    await runtime.createTerminal('id:repo-1::/tmp/wt-cli', {})

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        persistHostSessionBinding: true,
        resolvedWorkspace: {
          id: 'repo-1::/tmp/wt-cli',
          path: '/tmp/wt-cli',
          connectionId: null,
          repo: null,
          folderWorkspace: null
        }
      })
    )
  })

  it('spawns hidden so main answers startup queries before any pane mounts', async () => {
    const { runtime, spawn } = createRuntimeWithAttachedWindow()

    await runtime.createTerminal('id:repo-1::/tmp/wt-cli', {})

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ initiallyHidden: true }))
  })

  it('marks the spawned PTY runtime-session-owned', async () => {
    const { runtime } = createRuntimeWithAttachedWindow()

    await runtime.createTerminal('id:repo-1::/tmp/wt-cli', {})

    const pty = (
      runtime as unknown as {
        ptysById: Map<string, { runtimeSessionOwned: boolean; connected: boolean }>
      }
    ).ptysById.get('repo-1::/tmp/wt-cli@@a1b2c3d4')
    expect(pty?.connected).toBe(true)
    expect(pty?.runtimeSessionOwned).toBe(true)
  })
  it.each(['cancelled', 'refused', 'accepted-then-presentation-error'])(
    'releases only this create allocation on %s with a reused handle',
    async (failure) => {
      const { runtime, spawn } = createRuntimeWithAttachedWindow()
      const teams = new ClaudeAgentTeamsService()
      const existing = teams.createLaunchEnv({
        leaderHandle: 'shared-handle',
        baseEnv: {},
        shimDir: '/shim',
        shimBin: '/orca'
      })
      Object.assign(runtime, { claudeAgentTeams: teams })
      const signal = new AbortController()
      const allocation = vi.spyOn(teams, 'createLaunchEnv')
      const release = vi.spyOn(teams, 'releaseTeam')
      const prepare = vi
        .spyOn(launchPlan, 'buildRuntimeAgentTeamsLaunchPlan')
        .mockImplementation(async (args) => {
          const env = args.createTeamEnv('/shim', '/orca')
          if (failure === 'cancelled') {
            signal.abort()
          }
          return { plan: { env, command: 'claude' }, effectiveLaunchConfig: args.launchConfig }
        })
      if (failure === 'refused') {
        spawn.mockRejectedValue(new Error('execution_owner_unavailable'))
      }
      if (failure === 'accepted-then-presentation-error') {
        runtime.setPtyController({
          spawn,
          write: () => true,
          kill: () => true,
          getForegroundProcess: async () => null,
          adoptStablePane: async (args) => {
            const operation = { mustExist: false }
            const result = await args.spawnFresh!(operation)
            args.onOutcome?.({ kind: 'committed', result }, operation)
            return null
          }
        })
        vi.spyOn(runtime, 'assertPtyDidNotExitBeforeRegistration').mockImplementation(() => {
          throw new Error('presentation failed')
        })
      }
      try {
        await expect(
          runtime.createTerminal('id:repo-1::/tmp/wt-cli', {
            command: 'claude',
            preAllocatedHandle: 'shared-handle',
            signal: signal.signal
          })
        ).rejects.toThrow()
        const allocatedId = allocation.mock.results[0]!.value.teamId
        expect(allocatedId).not.toBe(existing.teamId)
        expect([teams.getActiveTeamCount(), release.mock.calls]).toEqual(
          failure === 'accepted-then-presentation-error' ? [2, []] : [1, [[allocatedId]]]
        )
      } finally {
        prepare.mockRestore()
      }
    }
  )

  it('releases only the prepared allocation when a reused handle adopts a late winner', async () => {
    const { runtime, spawn } = createRuntimeWithAttachedWindow()
    const teams = new ClaudeAgentTeamsService()
    const existing = teams.createLaunchEnv({
      leaderHandle: 'shared-handle',
      baseEnv: {},
      shimDir: '/shim',
      shimBin: '/orca'
    })
    Object.assign(runtime, { claudeAgentTeams: teams })
    const allocation = vi.spyOn(teams, 'createLaunchEnv')
    const release = vi.spyOn(teams, 'releaseTeam')
    const prepare = vi
      .spyOn(launchPlan, 'buildRuntimeAgentTeamsLaunchPlan')
      .mockImplementation(async (args) => ({
        plan: { env: args.createTeamEnv('/shim', '/orca'), command: 'claude' },
        effectiveLaunchConfig: args.launchConfig
      }))
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      adoptStablePane: async (args) => {
        const operation = { mustExist: false }
        const result = { ...(await args.spawnFresh!(operation)), isReattach: true }
        expect(allocation).toHaveBeenCalledTimes(1)
        expect(teams.getActiveTeamCount()).toBe(2)
        expect(release).not.toHaveBeenCalled()
        args.onOutcome?.({ kind: 'adopted', result }, operation)
        return {
          result,
          owner: {
            handle: 'shared-handle',
            tabId: args.tabId,
            leafId: args.leafId,
            ptyId: result.id
          }
        }
      }
    })
    try {
      const result = await runtime.createTerminal('id:repo-1::/tmp/wt-cli', {
        command: 'claude',
        preAllocatedHandle: 'shared-handle'
      })
      const allocatedId = allocation.mock.results[0]!.value.teamId
      expect(allocatedId).not.toBe(existing.teamId)
      expect(spawn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          env: expect.objectContaining({ ORCA_AGENT_TEAMS_TEAM_ID: allocatedId })
        })
      )
      expect(result).toMatchObject({ ptyId: 'repo-1::/tmp/wt-cli@@a1b2c3d4', isReattach: true })
      expect([teams.getActiveTeamCount(), release.mock.calls]).toEqual([1, [[allocatedId]]])
      await expect(
        teams.handleTmuxCompat(
          { ...existing, envPane: existing.leaderPane, argv: ['list-panes', '-F', '#{pane_id}'] },
          runtime
        )
      ).resolves.toMatchObject({ ok: true, stdout: '%1\n', exitCode: 0 })
    } finally {
      prepare.mockRestore()
    }
  })
})

it.each(['refused', 'adopted', 'stable-adopted', 'ensure-adopted', 'fresh-unavailable'] as const)(
  'publishes the effective %s terminal rather than the requested saved recipe',
  async (kind) => {
    const { runtime, spawn } = createRuntimeWithAttachedWindow()
    const config = { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
    const adopted = kind === 'adopted' || kind === 'stable-adopted' || kind === 'ensure-adopted'
    const ownerSurface = {
      worktreeId: 'repo-1::/tmp/wt-cli',
      terminalHandle: 'owner-handle',
      tabId: 'owner-tab',
      leafId: '11111111-1111-4111-8111-111111111111'
    }
    if (adopted && kind !== 'adopted') {
      // An adopted surface is registered; a bare provider reattach need not be.
      runtime.registerPty('effective-pty', ownerSurface.worktreeId, null, {
        tabId: ownerSurface.tabId,
        leafId: ownerSurface.leafId,
        incarnationId: 'physical-i1',
        terminalHandle: ownerSurface.terminalHandle
      })
    }
    const coldRestore = { scrollback: 'checkpoint A', cwd: '/tmp/wt-cli', cols: 80, rows: 24 }
    spawn.mockResolvedValue({
      id: 'effective-pty',
      pid: 42,
      incarnationId: 'physical-i1',
      coldRestore,
      snapshot: 'current image B',
      snapshotCols: 80,
      snapshotRows: 24,
      snapshotSeq: 7,
      providerSequence: { value: 7, generation: 'continued' },
      attachedGrid: { cols: 80, rows: 24 },
      isAlternateScreen: false,
      replay: 'provider backlog',
      shellReadyArmed: true,
      openCodeCapabilities: { version: '2.0.16', pluginApi: 'v2', promptMode: 'prefill' },
      ...(adopted
        ? { launchAgent: 'codex', launchConfig: config, launchToken: 'owner-token' }
        : {}),
      ...(kind === 'adopted' ? { isReattach: true } : {}),
      ...(kind === 'stable-adopted'
        ? {
            stablePaneOwner: {
              handle: ownerSurface.terminalHandle,
              tabId: ownerSurface.tabId,
              leafId: ownerSurface.leafId
            }
          }
        : {}),
      ...(kind === 'ensure-adopted'
        ? {
            agentSessionEnsure: {
              disposition: 'adopted',
              owner: {
                claim: {
                  digestVersion: 1,
                  keyId: 'key',
                  identityDigest: 'C',
                  worktreeScopeDigest: 'wt',
                  agent: 'codex'
                },
                generation: 'owner-generation',
                phase: 'live',
                ptyId: 'effective-pty',
                surface: ownerSurface
              }
            }
          }
        : {}),
      ...(kind === 'refused'
        ? {
            agentResumeRefused: 'chat-home',
            agentResumeUnavailable: true,
            savedResumeDecision: {
              agent: 'claude',
              providerSession: { key: 'session_id', id: 'C' },
              verdict: 'chat-home'
            }
          }
        : {}),
      ...(kind === 'fresh-unavailable'
        ? {
            agentResumeUnavailable: true,
            launchAgent: 'codex',
            launchConfig: config,
            launchToken: 'actual-fresh-token'
          }
        : {})
    })
    const result = await runtime.createTerminal('id:repo-1::/tmp/wt-cli', {
      launchAgent: 'claude',
      title: 'Rejected C',
      resumeOrigin: 'saved',
      resumeProviderSession: { key: 'session_id', id: 'C' },
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} }
    })
    expect(result).toEqual({
      handle: expect.any(String),
      tabId: expect.any(String),
      paneKey: expect.any(String),
      ptyId: 'effective-pty',
      savedStartupCwd: '/tmp/wt-cli',
      worktreeId: 'repo-1::/tmp/wt-cli',
      title: kind === 'fresh-unavailable' ? 'Rejected C' : null,
      launchConfig: kind === 'refused' ? undefined : config,
      launchAgent: kind === 'refused' ? undefined : 'codex',
      launchToken: kind === 'refused' ? undefined : adopted ? 'owner-token' : 'actual-fresh-token',
      executionHostId: 'local',
      hostPlatform: process.platform,
      incarnationId: 'physical-i1',
      surface: 'background',
      processId: 42,
      ...(adopted ? { isReattach: true } : { coldRestore }),
      ...(kind === 'ensure-adopted' ? { agentSessionDisposition: 'adopted' } : {}),
      ...(!adopted ? { agentResumeUnavailable: true } : {}),
      ...(kind === 'refused'
        ? {
            agentResumeRefused: 'chat-home',
            savedResumeDecision: {
              agent: 'claude',
              providerSession: { key: 'session_id', id: 'C' },
              verdict: 'chat-home'
            }
          }
        : {}),
      warning: expect.any(String)
    })
    expect(runtime.resolveTerminalPane(result.paneKey ?? '', result.worktreeId)).toMatchObject({
      handle: result.handle,
      ptyId: 'effective-pty',
      connected: true
    })
    expect(result.agentResumeRefused).toBe(kind === 'refused' ? 'chat-home' : undefined)
    expect(result.launchAgent).toBe(kind === 'refused' ? undefined : 'codex')
    expect(result.launchConfig).toEqual(kind === 'refused' ? undefined : config)
    if (kind === 'refused') {
      expect(result.title).not.toBe('Rejected C')
    }
    if (kind === 'fresh-unavailable') {
      expect(result.launchToken).toBe('actual-fresh-token')
    }
  }
)

it.each(['unchanged', 'hook', 'config', 'incarnation', 'handle'] as const)(
  'samples the actual created PTY after snapshot awaits and revalidates %s on reconnect',
  async (change) => {
    const { runtime, spawn } = createRuntimeWithAttachedWindow()
    const providerSession = { key: 'session_id' as const, id: 'C' }
    spawn.mockResolvedValue({
      id: 'effective-pty',
      incarnationId: 'i1',
      agentResumeUnavailable: true,
      agentResumeRefused: 'chat-home',
      savedResumeDecision: { agent: 'claude', providerSession, verdict: 'chat-home' }
    })
    const terminal = await runtime.createTerminal('id:repo-1::/tmp/wt-cli', {
      tabId: 'saved-tab',
      leafId: '11111111-1111-4111-8111-111111111111',
      launchAgent: 'claude',
      resumeOrigin: 'saved',
      resumeProviderSession: providerSession
    })
    let snapshotStarted = false
    let finishSnapshot = () => {}
    let handle = terminal.handle
    const harness = startDesktopMultiplexSubscribe({
      resolveLiveLeafForHandle: () => runtime.resolveLiveLeafForHandle(handle),
      getPtyExecutionHostMetadata: runtime.getPtyExecutionHostMetadata.bind(runtime),
      getTerminalLaunchResult: runtime.getTerminalLaunchResult.bind(runtime),
      serializeTerminalBuffer: () =>
        new Promise((resolve) => {
          snapshotStarted = true
          finishSnapshot = () => resolve({ data: 'shell$ ', cols: 80, rows: 24 })
        })
    })
    try {
      await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
      sendDesktopMultiplexSubscribe(harness.handlers)
      await vi.waitFor(() => expect(snapshotStarted).toBe(true))
      if (change === 'hook') {
        runtime.recordCliWriterConversation({
          paneKey: 'saved-tab:11111111-1111-4111-8111-111111111111',
          connectionId: null,
          receivedAt: 1,
          stateStartedAt: 1,
          providerSession,
          payload: { state: 'done', prompt: '', agentType: 'claude' },
          agentPresence: {
            agent: 'claude',
            process: { pid: 12, platform: 'darwin', startTime: 's' }
          }
        })
      } else if (change === 'config') {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime owns this PTY map; mutate its actual record to model a replacement launch.
        const records = (runtime as unknown as { ptysById: Map<string, RuntimePtyWorktreeRecord> })
          .ptysById
        const pty = records.get('effective-pty')!
        pty.launchConfig = { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
      } else if (change === 'incarnation') {
        runtime.registerPty('effective-pty', 'repo-1::/tmp/wt-cli', null, {
          tabId: 'saved-tab',
          leafId: '11111111-1111-4111-8111-111111111111',
          incarnationId: 'i2'
        })
      } else if (change === 'handle') {
        handle = 'stale-handle'
      }
      finishSnapshot()
      const events = () => harness.messages.map((message) => JSON.parse(message).result)
      const stale = change === 'handle' || change === 'incarnation'
      await vi.waitFor(() =>
        expect(events().some((event) => event?.type === (stale ? 'end' : 'subscribed'))).toBe(true)
      )
      if (stale) {
        expect(events().some((event) => event?.type === 'subscribed')).toBe(false)
        const error = harness.binaryFrames
          .map(decodeTerminalStreamFrame)
          .find((frame) => frame?.opcode === TerminalStreamOpcode.Error)
        expect(error && decodeTerminalStreamText(error.payload)).toBe('terminal_handle_stale')
      } else {
        const result = events().find((event) => event?.type === 'subscribed').launchResult
        expect(result).toMatchObject({ ptyId: 'effective-pty', incarnationId: 'i1' })
        expect(result.agentResumeRefused).toBe(change === 'unchanged' ? 'chat-home' : undefined)
        harness.messages.splice(0)
        snapshotStarted = false
        sendDesktopMultiplexSubscribe(harness.handlers)
        await vi.waitFor(() => expect(snapshotStarted).toBe(true))
        finishSnapshot()
        await vi.waitFor(() =>
          expect(events().some((event) => event?.type === 'subscribed')).toBe(true)
        )
        expect(events().find((event) => event?.type === 'subscribed').launchResult).toEqual(result)
      }
    } finally {
      harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
      await harness.dispatchPromise
    }
  }
)
