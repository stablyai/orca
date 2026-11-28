import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assemblePtySpawnLaunchOptions } from './spawn-options-assembly'

const assemble = () =>
  assemblePtySpawnLaunchOptions({
    args: { cols: 80, rows: 24, launchAgent: 'claude' },
    env: {},
    envToDelete: [],
    launchCommand: 'claude --dangerously-skip-permissions',
    cwd: undefined,
    isDaemonHostSpawn: true,
    preAdoptedStablePane: false,
    isNewSession: true,
    codexRuntime: 'host',
    expectedWslDistro: null,
    requestedAgentTeamsPath: undefined,
    selectedCodexHomePath: null,
    shellOverride: undefined,
    paneKey: null,
    sessionId: undefined,
    spawnIntent: undefined,
    store: undefined,
    claudeAuth: null
  })

beforeEach(() => {
  // A root CI container may export these; the gate must be tested apart from the runner's env.
  vi.stubEnv('IS_SANDBOX', '')
  vi.stubEnv('CLAUDE_CODE_BUBBLEWRAP', '')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

// Claude exits as root on its bypass switch; the host that spawns the shell owns that uid.
describe.skipIf(process.platform === 'win32')('root-host Claude spawn', () => {
  it('spawns without the switch and with a pane notice only when this host runs as root', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0)
    const root = await assemble()
    expect(root.spawnOptions.command).toBe('claude')
    expect(root.spawnOptions.startupNotice).toContain('[orca]')
    vi.spyOn(process, 'getuid').mockReturnValue(1000)
    const user = await assemble()
    expect(user.spawnOptions.command).toBe('claude --dangerously-skip-permissions')
    expect(user.spawnOptions.startupNotice).toBeUndefined()
  })
})
