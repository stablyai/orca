import type { BrowserWindow } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../../../shared/child-process/run-process'
import { unregisterPty } from '../../../memory/pty-registry'
import { SessionNotFoundError } from '../../../daemon/daemon-errors'
import type {
  IPtyProvider,
  PtySpawnOptions as PtyProviderSpawnOptions
} from '../../../providers/types'
import { noCodexResumeLaunch } from '../host-env/codex-resume'
import { getLocalPtyProvider, localProvider, setLocalPtyProvider } from '../provider/registry'
import { agentSessionOwners } from '../pane/agent-session-owners'
import { rendererSerializerReadiness } from '../pane/serializer-state'
import { finishPtyShutdown } from '../provider/liveness'
import { ptyIncarnationById, ptyOwnership } from '../provider/ownership-state'
import { spawnPtyFromRuntimeController } from './spawn'
import { executeRuntimePtySpawn } from './spawn-execute'
import { prepareRuntimePtySpawn } from './spawn-preflight'
import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from './spawn-state'
import type { PtyRuntimeControllerDeps } from './controller-deps'

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }))

vi.mock('../../../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))
vi.mock('../../../telemetry/client', () => ({ track: trackMock }))

const REFERENCE = 'doppler-ref://lets-tango/dev_ops/POSTHOG_READ_ONLY'
const SENTINEL = 'sentinel-plaintext-secret'
const OK = {
  code: 0,
  signal: null,
  stdout: `${SENTINEL}\n`,
  stderr: '',
  timedOut: false,
  outputTruncated: false
} as const

function createControllerDeps(): PtyRuntimeControllerDeps {
  return {
    getLocalPtyStartupPromise: () => undefined,
    getLocalPtyProviderStartupPromise: () => undefined,
    adoptStablePane: async () => null,
    assertFolderWorkspacePtyPathUsable: () => {},
    resolvePtySpawnStartupCwd: (_worktreeId, cwd) => cwd,
    prepareCodexResumeHome: () => null,
    noCodexResumeLaunch,
    resolveCodexResumeLaunch: async (command) => noCodexResumeLaunch(command),
    reconcileSharedRuntimeResumeHome: async (resumeHome) => resumeHome.codexHomePath,
    stripSequencedStartupResumeArgv: (env) => env,
    requestSerializedBuffer: async () => null,
    shutdownProviderAndDetectExit: async () => true,
    rememberSyntheticKillExit: () => {},
    rememberRetiredRejectedPty: () => {},
    sendPtyExitToRenderer: vi.fn(),
    trustedTerminalHandleEnv: new Set<string>(),
    sendPtySpawnedToRenderer: vi.fn(),
    finishPtyShutdown,
    retiredRejectedPtyIds: new Map<string, NodeJS.Timeout>(),
    reversibleStopOwnersByPtyId: new Map<string, number>(),
    mainWindow: {} as BrowserWindow
  }
}

function createState() {
  return createRuntimePtySpawnState(createControllerDeps(), {
    cols: 100,
    rows: 30,
    env: { POSTHOG_READ_ONLY: REFERENCE }
  })
}

function createClaimArgs(): RuntimePtySpawnArgs {
  return {
    cols: 100,
    rows: 30,
    env: { POSTHOG_READ_ONLY: REFERENCE },
    agentSessionEnsure: {
      claim: {
        digestVersion: 1,
        keyId: 'key-1',
        identityDigest: 'a'.repeat(43),
        worktreeScopeDigest: 'b'.repeat(43),
        agent: 'codex'
      },
      surface: {
        worktreeId: 'workspace-1',
        tabId: 'tab-1',
        leafId: 'leaf-1',
        terminalHandle: 'term_claim'
      }
    }
  }
}

function providerWith(spawn: IPtyProvider['spawn']): IPtyProvider {
  const provider = Object.create(localProvider) as IPtyProvider
  provider.spawn = spawn
  return provider
}

const LEAF_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function arrangeStableOwnerPane(ctx: ReturnType<typeof createState>, ptyId: string): void {
  ctx.args.worktreeId = 'workspace-1'
  ctx.spawnIdentityPaneKey = `tab-1:${LEAF_ID}`
  let paneRetired = false
  ctx.deps.runtime = {
    resolveTerminalPane: () => {
      if (paneRetired) {
        throw new Error('terminal_not_found')
      }
      return { handle: 'term_stale', ptyId, tabId: 'tab-1', leafId: LEAF_ID, connected: true }
    },
    onPtyExit: () => {
      paneRetired = true
    }
  } as unknown as PtyRuntimeControllerDeps['runtime']
  ctx.deps.store = {
    getWorkspaceSession: () => ({})
  } as unknown as PtyRuntimeControllerDeps['store']
}

describe('runtime PTY secret references', () => {
  beforeEach(() => {
    vi.mocked(runProcess).mockReset()
    vi.mocked(runProcess).mockResolvedValue(OK)
    trackMock.mockReset()
  })

  it('rejects invalid candidates before account and environment assembly', async () => {
    const ctx = createState()
    ctx.args.env = { CODEX_HOME: 'doppler-ref://lets-tango/dev_ops/CODEX_HOME' }
    const accountSelection = vi.fn()
    ctx.deps.getSelectedCodexHomePath = accountSelection

    await expect(prepareRuntimePtySpawn(ctx)).rejects.toMatchObject({
      code: 'invalid-reference',
      envKey: 'CODEX_HOME'
    })
    expect(accountSelection).not.toHaveBeenCalled()
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('resolves only the runtime provider input', async () => {
    const ctx = createState()
    ctx.spawnOptions = {
      cols: 100,
      rows: 30,
      command: '/usr/local/bin/claude',
      env: { POSTHOG_READ_ONLY: REFERENCE, CLAUDE_CONFIG_DIR: '/account/claude' }
    }
    const spawn = vi.fn(async () => ({ id: 'pty-runtime' }))
    ctx.provider = providerWith(spawn)

    await executeRuntimePtySpawn(ctx)

    expect(spawn).toHaveBeenCalledWith({
      cols: 100,
      rows: 30,
      command: '/usr/local/bin/claude',
      env: {
        POSTHOG_READ_ONLY: SENTINEL,
        CLAUDE_CONFIG_DIR: '/account/claude'
      }
    })
    expect(ctx.spawnOptions.env).toEqual({
      POSTHOG_READ_ONLY: REFERENCE,
      CLAUDE_CONFIG_DIR: '/account/claude'
    })
    expect(ctx.spawnOptions.command).toBe('/usr/local/bin/claude')
  })

  it('resolves a fresh agent-session claim through the runtime controller entry', async () => {
    const args = createClaimArgs()
    let spawned = false
    const spawn = vi.fn(async () => {
      spawned = true
      return { id: 'pty-runtime-claim', incarnationId: 'incarnation-1' }
    })
    const provider = providerWith(spawn)
    provider.listProcesses = async () =>
      spawned
        ? [
            {
              id: 'pty-runtime-claim',
              incarnationId: 'incarnation-1',
              cwd: '/work/repo',
              title: 'codex'
            }
          ]
        : []
    const previousProvider = getLocalPtyProvider()
    setLocalPtyProvider(provider)

    try {
      const response = await spawnPtyFromRuntimeController(createControllerDeps(), args)

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          env: { POSTHOG_READ_ONLY: SENTINEL },
          agentSessionEnsure: args.agentSessionEnsure
        })
      )
      expect(args.env).toEqual({ POSTHOG_READ_ONLY: REFERENCE })
      expect(agentSessionOwners.find(args.agentSessionEnsure!.claim)).toMatchObject({
        ptyId: 'pty-runtime-claim',
        claim: args.agentSessionEnsure!.claim,
        surface: args.agentSessionEnsure!.surface
      })
      expect(response).toMatchObject({
        id: 'pty-runtime-claim',
        incarnationId: 'incarnation-1',
        agentSessionEnsure: { disposition: 'created' }
      })
      expect(JSON.stringify(response)).not.toContain(SENTINEL)
    } finally {
      agentSessionOwners.release('pty-runtime-claim')
      ptyOwnership.delete('pty-runtime-claim')
      ptyIncarnationById.delete('pty-runtime-claim')
      rendererSerializerReadiness.clear('pty-runtime-claim')
      unregisterPty('pty-runtime-claim')
      setLocalPtyProvider(previousProvider)
    }
  })

  it.each([
    ['timeout', () => vi.mocked(runProcess).mockResolvedValue({ ...OK, timedOut: true })],
    ['truncated', () => vi.mocked(runProcess).mockResolvedValue({ ...OK, outputTruncated: true })],
    ['nonzero-exit', () => vi.mocked(runProcess).mockResolvedValue({ ...OK, code: 1 })],
    [
      'empty-output',
      () => vi.mocked(runProcess).mockResolvedValue({ ...OK, stdout: '', stderr: SENTINEL })
    ],
    ['spawn-failure', () => vi.mocked(runProcess).mockRejectedValue(new Error(SENTINEL))]
  ] as const)(
    'keeps secret process output out of the %s controller failure boundary',
    async (code, arrangeFailure) => {
      arrangeFailure()
      const args: RuntimePtySpawnArgs = {
        cols: 100,
        rows: 30,
        env: { POSTHOG_READ_ONLY: REFERENCE },
        telemetry: {
          agent_kind: 'codex',
          launch_source: 'new_workspace_composer',
          request_kind: 'new'
        }
      }
      const spawn = vi.fn(async () => ({ id: 'pty-must-not-spawn' }))
      const provider = providerWith(spawn)
      const previousProvider = getLocalPtyProvider()
      const consoleSpies = [
        vi.spyOn(console, 'debug').mockImplementation(() => undefined),
        vi.spyOn(console, 'error').mockImplementation(() => undefined),
        vi.spyOn(console, 'info').mockImplementation(() => undefined),
        vi.spyOn(console, 'log').mockImplementation(() => undefined),
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      ]
      setLocalPtyProvider(provider)

      try {
        const rejection = spawnPtyFromRuntimeController(createControllerDeps(), args)

        await expect(rejection).rejects.toMatchObject({ code, envKey: 'POSTHOG_READ_ONLY' })
        await expect(rejection).rejects.not.toThrow(SENTINEL)
        expect(args.env).toEqual({ POSTHOG_READ_ONLY: REFERENCE })
        expect(spawn).not.toHaveBeenCalled()
        expect(trackMock).not.toHaveBeenCalled()
        expect(JSON.stringify(consoleSpies.flatMap((spy) => spy.mock.calls))).not.toContain(
          SENTINEL
        )
        expect(JSON.stringify(trackMock.mock.calls)).not.toContain(SENTINEL)
      } finally {
        setLocalPtyProvider(previousProvider)
        for (const spy of consoleSpies) {
          spy.mockRestore()
        }
      }
    }
  )

  it('resolves credentials for the fresh spawn after failed stable-owner adoption', async () => {
    const ctx = createState()
    arrangeStableOwnerPane(ctx, 'pty-runtime-stale')
    ctx.spawnOptions = {
      cols: 100,
      rows: 30,
      command: '/usr/local/bin/claude',
      env: { POSTHOG_READ_ONLY: REFERENCE }
    }
    const spawn = vi.fn(async (options: PtyProviderSpawnOptions) => {
      if (options.attachOnly) {
        throw new SessionNotFoundError('pty-runtime-stale')
      }
      return { id: 'pty-runtime-fresh' }
    })
    ctx.provider = providerWith(spawn)

    await executeRuntimePtySpawn(ctx)

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      attachOnly: true,
      sessionId: 'pty-runtime-stale',
      env: { POSTHOG_READ_ONLY: REFERENCE }
    })
    expect(spawn.mock.calls[1]?.[0]).toEqual({
      cols: 100,
      rows: 30,
      command: '/usr/local/bin/claude',
      env: { POSTHOG_READ_ONLY: SENTINEL }
    })
    expect(ctx.spawnOptions.env).toEqual({ POSTHOG_READ_ONLY: REFERENCE })
    expect(ctx.result).toMatchObject({ id: 'pty-runtime-fresh' })
  })

  it('adopts a live stable owner without any secret lookup', async () => {
    const ctx = createState()
    arrangeStableOwnerPane(ctx, 'pty-runtime-live')
    ctx.spawnOptions = { cols: 100, rows: 30, env: { POSTHOG_READ_ONLY: REFERENCE } }
    const spawn = vi.fn(async () => ({ id: 'pty-runtime-live', isReattach: true }))
    ctx.provider = providerWith(spawn)

    await executeRuntimePtySpawn(ctx)

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ attachOnly: true, env: { POSTHOG_READ_ONLY: REFERENCE } })
    )
    expect(runProcess).not.toHaveBeenCalled()
    expect(ctx.result).toMatchObject({ id: 'pty-runtime-live' })
  })

  it('refuses the fresh spawn when resolution fails after failed adoption', async () => {
    vi.mocked(runProcess).mockResolvedValue({ ...OK, code: 1 })
    const ctx = createState()
    arrangeStableOwnerPane(ctx, 'pty-runtime-gone')
    ctx.spawnOptions = { cols: 100, rows: 30, env: { POSTHOG_READ_ONLY: REFERENCE } }
    const spawn = vi.fn(async (options: PtyProviderSpawnOptions) => {
      if (options.attachOnly) {
        throw new SessionNotFoundError('pty-runtime-gone')
      }
      return { id: 'pty-runtime-must-not-spawn' }
    })
    ctx.provider = providerWith(spawn)

    await expect(executeRuntimePtySpawn(ctx)).rejects.toMatchObject({
      code: 'nonzero-exit',
      envKey: 'POSTHOG_READ_ONLY'
    })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ attachOnly: true })
  })

  it('rejects WSL before Doppler or provider spawn', async () => {
    const ctx = createState()
    ctx.expectedWslDistro = 'Ubuntu'
    ctx.spawnOptions = { cols: 100, rows: 30, env: { POSTHOG_READ_ONLY: REFERENCE } }
    const spawn = vi.fn(async () => ({ id: 'pty-wsl' }))
    ctx.provider = providerWith(spawn)

    await expect(executeRuntimePtySpawn(ctx)).rejects.toMatchObject({ code: 'remote-target' })
    expect(runProcess).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })
})
