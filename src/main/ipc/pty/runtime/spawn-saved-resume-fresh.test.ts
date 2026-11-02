import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import * as owners from '../pane/agent-session-owners'
import { localProvider } from '../provider/registry'
import { spawnPtyFromRuntimeController } from './spawn'
import { savedResumeDeps, savedResumeHost } from './spawn-saved-resume.test-fixture'
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

// Pi resumes an exact session file, so it alone is still decided before spawn.
const ID = '019f1abe-902b-7b79-8a12-c0169ed3e187'
const TRANSCRIPT = `/home/u/.pi/agent/sessions/--repo--/2026-06-30T22-55-24-203Z_${ID}.jsonl`
const SESSION = { key: 'session_id' as const, id: ID, transcriptPath: TRANSCRIPT }
const RESUME = `pi '--session' '${TRANSCRIPT}'`

const SEED_ROWS = () => [
  {
    paneKey: 'tab-1:leaf',
    connectionId: null,
    agentType: 'pi' as const,
    state: 'done' as const,
    prompt: '',
    receivedAt: 5,
    stateStartedAt: 5,
    providerSessionOnly: true,
    providerSession: SESSION
  }
]
const host = () => savedResumeHost(SEED_ROWS)
const deps = savedResumeDeps

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
      launchAgent: 'pi',
      resumeOrigin: 'saved',
      resumeProviderSession: SESSION,
      launchConfig: {
        agentCommand: 'pi --thinking high',
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

    expect(dispatched?.command).toMatch(/^pi --thinking high\b/)
    expect(dispatched?.command).not.toContain(ID)
    expect(dispatched?.env).toEqual({ ORCA_AGENT_LAUNCH_TOKEN: 'token' })
    expect(result).toMatchObject({
      agentResumeUnavailable: true,
      launchAgent: 'pi',
      launchConfig: { agentCommand: 'pi --thinking high' },
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
    const typed = `  pi   --session ${TRANSCRIPT} --thinking "very high" # mine`
    const { dispatched } = await spawnSaved(host(), { resumeOrigin: undefined, command: typed })
    expect(dispatched?.command).toBe(typed)
    expect(hooks.captureLaunchSeed).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
  })

  it('unwinds the old conversation claim so the fresh agent never owns it', async () => {
    hooks.captureLaunchSeed.mockReturnValue(() => true)
    probe.mockResolvedValue('missing')
    const claim = {
      agent: 'pi',
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

  const TYPED = `pi  --session ${TRANSCRIPT}   --thinking low`
  it.each<[string, Record<string, unknown>]>([
    ['a saved restore of it starts fresh too', {}],
    ['an explicit resume of it keeps its own command', { resumeOrigin: undefined, command: TYPED }]
  ])('a request that joined the claim: %s', async (_label, joinerOverrides) => {
    hooks.captureLaunchSeed.mockReset().mockReturnValue(() => true)
    let reportMissing: (presence: string) => void = () => {}
    probe.mockReset().mockImplementation(() => new Promise((resolve) => (reportMissing = resolve)))
    const claim = {
      agent: 'pi' as const,
      digestVersion: 1 as const,
      keyId: 'key',
      identityDigest: 'joined-conversation',
      worktreeScopeDigest: 'scope'
    }
    const ensure = {
      claim,
      surface: { worktreeId: 'wt-1', tabId: 'tab-1', leafId: 'leaf', terminalHandle: 'h' }
    }
    const inventory = vi.spyOn(owners, 'reconcileAgentSessionOwnerListings').mockResolvedValue()
    const spawn = vi
      .spyOn(localProvider, 'spawn')
      .mockImplementation(async () => ({ id: `pty-${spawn.mock.calls.length}` }))
    const request = (overrides: Record<string, unknown> = {}) =>
      spawnPtyFromRuntimeController(deps(host()), {
        cols: 80,
        rows: 24,
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        command: RESUME,
        launchAgent: 'pi',
        resumeOrigin: 'saved',
        resumeProviderSession: SESSION,
        launchConfig: { agentCommand: 'pi', agentArgs: '', agentEnv: {} },
        env: {},
        agentSessionEnsure: ensure,
        ...overrides
      })
    try {
      const creator = request()
      await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
      const joiner = request(joinerOverrides)
      await new Promise((resolve) => setTimeout(resolve, 10))
      reportMissing('missing')
      const results = await Promise.all([creator, joiner])
      const [creatorCommand, joinerCommand] = spawn.mock.calls.map(([options]) => options.command)
      expect(creatorCommand).not.toContain(ID)
      expect(results[0]).toMatchObject({ agentResumeUnavailable: true })
      expect(results[0].resumeProviderSession).toBeUndefined()
      if (joinerOverrides.command) {
        expect(joinerCommand).toBe(TYPED)
        expect(results[1]).not.toHaveProperty('agentResumeUnavailable')
      } else {
        expect(joinerCommand).not.toContain(ID)
        expect(results[1]).toMatchObject({ agentResumeUnavailable: true })
        expect(results[1].resumeProviderSession).toBeUndefined()
      }
      // The joiner never read the seed or the store itself.
      expect(hooks.captureLaunchSeed).toHaveBeenCalledOnce()
      expect(probe).toHaveBeenCalledOnce()
    } finally {
      inventory.mockRestore()
      spawn.mockRestore()
    }
  })

  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ['an SSH pane', { connectionId: 'ssh-1' }, {}],
    ['a WSL pane', {}, { expectedWslDistro: 'Ubuntu' }],
    ['a sequenced startup script', { env: { ORCA_SEQUENCED_STARTUP_COMMAND: RESUME } }, {}],
    ['an agent with no readable store', { launchAgent: 'gemini' }, {}],
    ['an agent whose own function checks in the pane', { launchAgent: 'codex' }, {}]
  ])('reads no store for %s', async (_label, args, state) => {
    hooks.captureLaunchSeed.mockReset().mockReturnValue(() => true)
    probe.mockClear()
    const ctx = {
      args: {
        command: RESUME,
        launchAgent: 'pi',
        resumeOrigin: 'saved',
        resumeProviderSession: SESSION,
        launchConfig: { agentCommand: 'pi', agentArgs: '', agentEnv: {} },
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
      refused: { agent: 'pi' as const, providerSession: SESSION }
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
