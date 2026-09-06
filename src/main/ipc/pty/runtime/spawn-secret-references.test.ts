import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../../../shared/child-process/run-process'
import type { IPtyProvider } from '../../../providers/types'
import { getLocalPtyProvider, localProvider, setLocalPtyProvider } from '../provider/registry'
import { agentSessionOwners } from '../pane/agent-session-owners'
import { executeRuntimePtySpawn } from './spawn-execute'
import { prepareRuntimePtySpawn } from './spawn-preflight'
import { createRuntimePtySpawnState } from './spawn-state'
import type { PtyRuntimeControllerDeps } from './controller-deps'

vi.mock('../../../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))

const REFERENCE = 'doppler-ref://lets-tango/dev_ops/POSTHOG_READ_ONLY'
const SENTINEL = 'sentinel-plaintext-secret'

function createState() {
  return createRuntimePtySpawnState(
    { trustedTerminalHandleEnv: new Set<string>() } as PtyRuntimeControllerDeps,
    { cols: 100, rows: 30, env: { POSTHOG_READ_ONLY: REFERENCE } }
  )
}

function providerWith(spawn: IPtyProvider['spawn']): IPtyProvider {
  const provider = Object.create(localProvider) as IPtyProvider
  provider.spawn = spawn
  return provider
}

describe('runtime PTY secret references', () => {
  beforeEach(() => {
    vi.mocked(runProcess).mockReset()
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      stdout: `${SENTINEL}\n`,
      stderr: '',
      timedOut: false,
      outputTruncated: false
    })
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

  it('resolves a fresh runtime-controller claim without changing durable input', async () => {
    const ctx = createState()
    const claim = {
      digestVersion: 1 as const,
      keyId: 'key-1',
      identityDigest: 'a'.repeat(43),
      worktreeScopeDigest: 'b'.repeat(43),
      agent: 'codex' as const
    }
    ctx.args.agentSessionEnsure = {
      claim,
      surface: {
        worktreeId: 'workspace-1',
        tabId: 'tab-1',
        leafId: 'leaf-1',
        terminalHandle: 'term_claim'
      }
    }
    ctx.spawnOptions = { cols: 100, rows: 30, env: { POSTHOG_READ_ONLY: REFERENCE } }
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
    ctx.provider = provider
    const previousProvider = getLocalPtyProvider()
    setLocalPtyProvider(provider)

    try {
      await executeRuntimePtySpawn(ctx)

      expect(spawn).toHaveBeenCalledWith({
        cols: 100,
        rows: 30,
        env: { POSTHOG_READ_ONLY: SENTINEL }
      })
      expect(ctx.spawnOptions.env?.POSTHOG_READ_ONLY).toBe(REFERENCE)
      expect(ctx.result.agentSessionEnsure).toMatchObject({ disposition: 'created' })
    } finally {
      agentSessionOwners.release('pty-runtime-claim')
      setLocalPtyProvider(previousProvider)
    }
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
