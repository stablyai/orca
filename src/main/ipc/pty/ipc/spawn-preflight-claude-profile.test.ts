import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { ClaudeProfileRoutingService } from '../../../claude-accounts/claude-profile-routing-service'
import type { ClaudeAccountSelectionTarget } from '../../../claude-accounts/runtime-selection'
import { preparePtyIpcSpawnPreflight } from './spawn-preflight'
import { createPtyIpcSpawnState } from './spawn-state'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'

const profiles = vi.hoisted(() => {
  const state: { authority?: Pick<ClaudeProfileRoutingService, 'terminalEnv'> } = {}
  return state
})
vi.mock('../../../claude-accounts/claude-profile-routing-authority', () => ({
  getClaudeProfileRoutingAuthority: () => profiles.authority
}))

const hostPlatform = process.platform
const WSL_CWD = '\\\\wsl.localhost\\Ubuntu\\home\\u'

async function preflight(shellOverride: string, gate = true) {
  const terminalEnv = vi.fn((target?: ClaudeAccountSelectionTarget) =>
    target?.runtime === 'wsl' ? { ORCA_CLAUDE_PROFILE_POINTER: '~/guest' } : {}
  )
  profiles.authority = gate ? { terminalEnv } : undefined
  const prepareClaudeAuth = vi.fn(async () => ({
    configDir: '/unused',
    envPatch: {},
    stripAuthEnv: false,
    provenance: 'system'
  }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preflight reads only these members for a fresh local spawn; later spawn stages are not run.
  const deps = {
    transitionSpawnHiddenRendererPtyDeliveryState: vi.fn(),
    assertFolderWorkspacePtyPathUsable: () => undefined,
    resolvePtySpawnStartupCwd: (_worktreeId: string | undefined, cwd: string | undefined) => cwd,
    getSettings: () => getDefaultSettings('/tmp'),
    prepareClaudeAuth
  } as unknown as PtySpawnIpcDeps
  const args: PtySpawnIpcArgs = {
    cols: 80,
    rows: 24,
    cwd: WSL_CWD,
    shellOverride,
    command: 'claude',
    env: { KEEP: '1' }
  }
  const ctx = createPtyIpcSpawnState(deps, args)
  await preparePtyIpcSpawnPreflight(ctx)
  return { terminalEnv, prepareClaudeAuth, env: args.env }
}

describe('renderer pty spawn preflight: Claude profile target', () => {
  afterEach(() => {
    profiles.authority = undefined
    Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
  })

  // Why every shell: a \\wsl$ cwd always launches wsl.exe (local-pty-launch-plan, daemon
  // shell-launch-plan), so the pane's claude is the guest's whatever shell was requested.
  it.each(['wsl.exe', 'powershell.exe', 'cmd.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'])(
    'gives a %s pane with a \\\\wsl$ cwd the guest pointer and launches Claude there',
    async (shell) => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const result = await preflight(shell)
      const target = { runtime: 'wsl', wslDistro: 'Ubuntu' }
      expect(result.terminalEnv).toHaveBeenCalledWith(target)
      expect(result.prepareClaudeAuth).toHaveBeenCalledWith(target)
      expect(result.env).toEqual({ KEEP: '1', ORCA_CLAUDE_PROFILE_POINTER: '~/guest' })
    }
  )

  it('adds no profile env while the gate is off', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const result = await preflight('wsl.exe', false)
    expect(result.prepareClaudeAuth).toHaveBeenCalledWith({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(result.env).toEqual({ KEEP: '1' })
  })
})
