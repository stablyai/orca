import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import * as owners from '../pane/agent-session-owners'
import { localProvider } from '../provider/registry'
import { finishPtyShutdown } from '../provider/liveness'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { spawnPtyFromRuntimeController } from './spawn'
import type { createRuntimePtySpawnState } from './spawn-state'
import { startSavedResumeFreshWhenMissing } from '../saved-resume-fresh/saved-resume-fresh-launch'

const hooks = vi.hoisted(() => ({
  forgetRefusedPaneResume: vi.fn(),
  captureLaunchSeed: vi.fn<() => (() => boolean) | null>()
}))
const probe = vi.hoisted(() => vi.fn())
vi.mock('../../../agent-hooks/server', () => ({ agentHookServer: hooks }))
vi.mock('../saved-resume-fresh/store-presence', () => ({ probeSavedResumeStore: probe }))
vi.mock('./spawn-preflight', () => ({ prepareRuntimePtySpawn: vi.fn(async () => null) }))
vi.mock('./spawn-options', () => ({
  buildRuntimePtySpawnOptions: vi.fn(async (ctx: ReturnType<typeof createRuntimePtySpawnState>) => {
    ctx.spawnIdentityPaneKey = 'tab-1:leaf'
    ctx.launchCommand = ctx.args.command
    ctx.spawnOptions = {
      cols: ctx.args.cols,
      rows: ctx.args.rows,
      command: ctx.args.command,
      env: ctx.args.env,
      launchAgent: ctx.args.launchAgent,
      ...(ctx.args.agentSessionEnsure ? { agentSessionEnsure: ctx.args.agentSessionEnsure } : {})
    }
    return null
  })
}))

const ID = '019f1abc-0000-7000-8000-00000000aaaa'
const RESUME = `codex 'resume' '${ID}'`

function host() {
  return {
    openAgentSessionRecordStore: async () =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: admission reads only these two members.
      ({
        listConversations: () => [],
        getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [] })
      }) as unknown as AgentSessionRecordStore,
    getTerminalLaunchResult: vi.fn(),
    forgetRefusedSavedResume: vi.fn(async () => {}),
    registerPty: vi.fn(),
    noteTerminalSpawnCommand: vi.fn(),
    reflowHeadlessTerminalToPtyGrid: vi.fn(),
    getAgentProviderSessionRows: () => [
      {
        paneKey: 'tab-1:leaf',
        connectionId: null,
        agentType: 'codex' as const,
        state: 'done' as const,
        prompt: '',
        receivedAt: 5,
        stateStartedAt: 5,
        providerSessionOnly: true,
        providerSession: { key: 'session_id' as const, id: ID }
      }
    ]
  }
}

function deps(runtime: ReturnType<typeof host>): PtyRuntimeControllerDeps {
  const noCodexResumeLaunch: PtyRuntimeControllerDeps['noCodexResumeLaunch'] = (command) => ({
    codexResumeHome: null,
    command
  })
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the spawn reads only the members `host` provides.
    runtime: runtime as unknown as OrcaRuntimeService,
    store: undefined,
    getSettings: () => getDefaultSettings('/tmp'),
    adoptStablePane: async (args) => {
      await args.spawnFresh?.({ mustExist: false })
      return null
    },
    getLocalPtyStartupPromise: () => undefined,
    getLocalPtyProviderStartupPromise: () => undefined,
    prepareCodexResumeHome: () => null,
    resolveCodexResumeLaunch: async (command) => noCodexResumeLaunch(command),
    noCodexResumeLaunch,
    reconcileSharedRuntimeResumeHome: async (resumeHome) => resumeHome.codexHomePath,
    assertWorkspaceAcceptsNewPty: () => undefined,
    resolvePtySpawnStartupCwd: (_worktreeId, cwd) => cwd,
    requestSerializedBuffer: async () => null,
    shutdownProviderAndDetectExit: async () => false,
    rememberSyntheticKillExit: () => {},
    rememberRetiredRejectedPty: () => {},
    sendPtyExitToRenderer: () => {},
    sendPtySpawnedToRenderer: () => {},
    finishPtyShutdown,
    trustedTerminalHandleEnv: new Set(),
    retiredRejectedPtyIds: new Map(),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the spawn never touches `mainWindow`.
    mainWindow: {} as BrowserWindow
  }
}

async function spawnSaved(
  runtime: ReturnType<typeof host>,
  overrides: Record<string, unknown> = {}
) {
  const spawn = vi.spyOn(localProvider, 'spawn').mockResolvedValue({ id: 'pane-pty' })
  const onResumeOutcome = vi.fn()
  try {
    const result = await spawnPtyFromRuntimeController(deps(runtime), {
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      command: RESUME,
      launchAgent: 'codex',
      resumeOrigin: 'saved',
      resumeProviderSession: { key: 'session_id', id: ID },
      launchConfig: {
        agentCommand: 'codex --sandbox workspace-write',
        agentArgs: '',
        agentEnv: {}
      },
      env: { ORCA_AGENT_LAUNCH_TOKEN: 'token' },
      onResumeOutcome,
      ...overrides
    })
    return { result, dispatched: spawn.mock.calls[0]?.[0], onResumeOutcome }
  } finally {
    spawn.mockRestore()
  }
}

describe('a saved restore whose conversation is gone', () => {
  it('launches the same agent fresh from its recipe and reports the existing started-fresh result', async () => {
    hooks.captureLaunchSeed.mockReturnValue(() => true)
    probe.mockResolvedValue('missing')
    const runtime = host()
    const { result, dispatched, onResumeOutcome } = await spawnSaved(runtime)

    expect(dispatched?.command).toMatch(/^codex --sandbox workspace-write\b/)
    expect(dispatched?.command).not.toContain(ID)
    expect(dispatched?.env).toEqual({ ORCA_AGENT_LAUNCH_TOKEN: 'token' })
    expect(result).toMatchObject({
      agentResumeUnavailable: true,
      launchAgent: 'codex',
      launchConfig: { agentCommand: 'codex --sandbox workspace-write' },
      savedResumeDecision: { verdict: 'admitted' }
    })
    expect(result).not.toHaveProperty('resumeProviderSession', expect.anything())
    expect(runtime.noteTerminalSpawnCommand).toHaveBeenCalledWith('pane-pty', dispatched?.command)
    expect(hooks.forgetRefusedPaneResume).toHaveBeenCalledWith(
      'tab-1:leaf',
      expect.objectContaining({ expectedStatus: expect.objectContaining({ receivedAt: 5 }) })
    )
    expect(runtime.forgetRefusedSavedResume).toHaveBeenCalledOnce()
    expect(onResumeOutcome.mock.calls).toEqual(
      ORCA_LAYOUT_OWNER_IS_MAIN ? [['pane-pty', 'resume-unavailable']] : []
    )
  })

  it.each(['found', 'unknown'])(
    'runs the requested resume unchanged when the store is %s',
    async (presence) => {
      hooks.captureLaunchSeed.mockReturnValue(() => true)
      probe.mockResolvedValue(presence)
      const runtime = host()
      const { result, dispatched } = await spawnSaved(runtime)
      expect(dispatched?.command).toBe(RESUME)
      expect(result).not.toHaveProperty('agentResumeUnavailable')
      expect(runtime.forgetRefusedSavedResume).not.toHaveBeenCalled()
    }
  )

  it('never consults the store for a typed resume and leaves its command byte-for-byte', async () => {
    hooks.captureLaunchSeed.mockClear()
    probe.mockClear()
    const typed = `  codex   resume ${ID} --sandbox "read only" # mine`
    const { dispatched } = await spawnSaved(host(), { resumeOrigin: undefined, command: typed })
    expect(dispatched?.command).toBe(typed)
    expect(hooks.captureLaunchSeed).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
  })

  it('unwinds the old conversation claim so the fresh agent never owns it', async () => {
    hooks.captureLaunchSeed.mockReturnValue(() => true)
    probe.mockResolvedValue('missing')
    const claim = {
      agent: 'codex',
      digestVersion: 1,
      keyId: 'key',
      identityDigest: 'old-conversation',
      worktreeScopeDigest: 'scope'
    }
    const inventory = vi.spyOn(owners, 'reconcileAgentSessionOwnerListings').mockResolvedValue()
    try {
      const { result, dispatched } = await spawnSaved(host(), {
        agentSessionEnsure: {
          claim,
          surface: { worktreeId: 'wt-1', tabId: 'tab-1', leafId: 'leaf', terminalHandle: 'h' }
        }
      })
      expect(dispatched?.command).not.toContain(ID)
      expect(dispatched?.agentSessionEnsure).toBeUndefined()
      expect(result.agentSessionEnsure).toBeUndefined()
      expect(owners.agentSessionOwners.find(claim as never)).toBeNull()
    } finally {
      inventory.mockRestore()
    }
  })

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ['an SSH pane', { connectionId: 'ssh-1' }, {}],
    ['a WSL pane', {}, { expectedWslDistro: 'Ubuntu' }],
    ['a sequenced startup script', { env: { ORCA_SEQUENCED_STARTUP_COMMAND: RESUME } }, {}],
    ['an agent with no readable store', { launchAgent: 'gemini' }, {}]
  ])('reads no store for %s', async (_label, args, state) => {
    hooks.captureLaunchSeed.mockReset().mockReturnValue(() => true)
    probe.mockClear()
    const ctx = {
      args: {
        command: RESUME,
        launchAgent: 'codex',
        resumeOrigin: 'saved',
        resumeProviderSession: { key: 'session_id', id: ID },
        launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} },
        ...args
      },
      spawnOptions: { cols: 80, rows: 24, command: RESUME, env: {} },
      expectedWslDistro: null,
      isDaemonHostSpawn: true,
      deps: { getSettings: () => getDefaultSettings('/tmp') },
      ...state
    }
    const admitted = {
      verdict: 'admitted' as const,
      refused: { agent: 'codex' as const, providerSession: { key: 'session_id' as const, id: ID } }
    }
    await expect(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: eligibility reads only these members.
      startSavedResumeFreshWhenMissing(
        ctx as never,
        'tab-1:leaf',
        { shellOverride: undefined },
        admitted
      )
    ).resolves.toBe(false)
    expect(probe).not.toHaveBeenCalled()
    expect(ctx.spawnOptions.command).toBe(RESUME)
  })
})
