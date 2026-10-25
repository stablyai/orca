import { describe, expect, it, vi } from 'vitest'
import { CLI_COMMAND_NAMES } from '../../main/startup/cli-command-names'
import { getCliLaunchArgs, getDirectServeLaunch } from '../../main/startup/cli-launch-redirect'
import { COMMAND_SPECS } from './index'

vi.mock('electron', () => ({ app: { commandLine: { getSwitchValue: () => '' } } }))

describe('CLI launch redirect command names', () => {
  it('routes every CLI root through command redirect or direct serve', () => {
    // Why agent-teams-tmux: the CLI dispatches it before spec parsing, and the tmux shim runs it.
    const roots = new Set([...COMMAND_SPECS.map((spec) => spec.path[0]), 'agent-teams-tmux'])
    const options = {
      platform: 'linux',
      isPackaged: true,
      commandNames: CLI_COMMAND_NAMES
    } as const
    expect(roots.size).toBeGreaterThan(0)

    for (const root of roots) {
      const argv = ['/opt/Orca/orca-ide', '--disable-gpu', root, '--json']
      const cliArgs = getCliLaunchArgs(argv, '/opt/Orca/resources/cli/index.js', options)
      if (root === 'serve') {
        expect(cliArgs, root).toBeNull()
        expect(getDirectServeLaunch(argv, options), root).toEqual({
          args: [root, '--json'],
          userDataPath: null,
          noSandbox: false
        })
      } else {
        expect(cliArgs, root).toEqual([root, '--json'])
      }
    }
  })
})
