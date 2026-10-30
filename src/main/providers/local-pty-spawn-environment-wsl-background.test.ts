import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildLocalPtySpawnEnvironment } from './local-pty-spawn-environment'
import type { LocalPtyLaunchPlan } from './local-pty-launch-plan'
import type { PtySpawnOptions } from './pty-provider-contract'
import { runAsWslLaunchUserAct } from '../wsl/wsl-background-exec-gate'
import { isWslUserActFor } from '../wsl/wsl-user-act-scope'

const plan: LocalPtyLaunchPlan = {
  startupAgentRecognition: null,
  defaultCwd: '',
  cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo',
  wslInfo: null,
  worktreeWslContext: undefined,
  preferredWslContext: undefined,
  launchWslContext: undefined,
  shellPath: 'wsl.exe',
  shellArgs: [],
  effectiveCwd: '',
  validationCwd: '',
  startupCommandDeliveredInShellArgs: false,
  windowsFallbackAttempts: [],
  shellReadyLaunch: null,
  getFallbackShellReadyConfig: undefined,
  primaryPreLaunchEnv: {},
  isWslShell: true,
  launchWslDistro: 'Ubuntu'
}
const hostPlatform = process.platform

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
})

// The daemon-off builder wraps its env prep the way provider/local-configure.ts does.
async function userActDuringDaemonOffPrep(spawn: Partial<PtySpawnOptions>): Promise<boolean[]> {
  const seen: boolean[] = []
  await buildLocalPtySpawnEnvironment({
    id: 'pane',
    spawn: { cols: 80, rows: 24, ...spawn },
    getOptions: () => ({
      buildSpawnEnv: (_id, baseEnv, ctx) =>
        runAsWslLaunchUserAct(
          {
            isWsl: ctx?.isWsl === true,
            passiveRestore: ctx?.wslPassiveRestore === true,
            distro: ctx?.wslDistro
          },
          async () => {
            seen.push(isWslUserActFor('Ubuntu'))
            return baseEnv
          }
        )
    }),
    plan
  })
  return seen
}

describe("daemon-off env prep for main's background start (STA-12870, E9)", () => {
  it('gives a background start no user-act scope', async () => {
    expect(await userActDuringDaemonOffPrep({ wslBackgroundStart: true })).toEqual([false])
  })

  it('gives a passive restore no user-act scope', async () => {
    expect(await userActDuringDaemonOffPrep({ wslPassiveRestore: true })).toEqual([false])
  })

  it("keeps the user's start a user act", async () => {
    expect(await userActDuringDaemonOffPrep({})).toEqual([true])
  })
})
