import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assemblePtySpawnLaunchOptions,
  type PtySpawnLaunchOptionsInput
} from './spawn-options-assembly'
import { buildAgentStartupPlan } from '../../../../shared/agent-launch/startup/tui-agent-startup'

const assemble = (overrides: Partial<PtySpawnLaunchOptionsInput> = {}) =>
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
    claudeAuth: null,
    ...overrides
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

  it('strips the appended bypass switch while keeping the authored command bytes', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0)
    const startup = buildAgentStartupPlan({
      agent: 'claude',
      cmdOverrides: { claude: 'claude  --model opus ' },
      platform: 'linux',
      prompt: '',
      agentArgs: '--dangerously-skip-permissions',
      allowEmptyPromptLaunch: true
    })!
    const root = await assemble({
      launchCommand: startup.launchCommand,
      launchConfig: startup.launchConfig
    })
    expect(root.spawnOptions.command).toBe('claude  --model opus ')
    const authored = await assemble({
      launchConfig: {
        agentArgs: '',
        agentEnv: {},
        commandProvenance: 'authored',
        authoredCommand: 'claude --dangerously-skip-permissions'
      }
    })
    expect(authored.spawnOptions.command).toBe('claude --dangerously-skip-permissions')
  })
})

it('inserts the picker team flag before the authored Claude arguments', async () => {
  const result = await assemble({
    args: { cols: 80, rows: 24, launchAgent: 'claude-agent-teams' },
    launchCommand: 'claude  --model opus',
    launchConfig: { agentArgs: '', agentEnv: {}, commandProvenance: 'authored' }
  })
  expect(result.spawnOptions.command).toBe('claude --teammate-mode in-process  --model opus')
})
