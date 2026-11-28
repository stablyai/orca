import { expect, it } from 'vitest'
import { createPtyShellLaunchPlan } from '../../../daemon/pty-subprocess/shell-launch-plan'
import { createLocalPtyLaunchPlan } from '../../local-pty/local-pty-launch-plan'

it.runIf(process.platform === 'win32')(
  'keeps the configured PowerShell executable and its argv in both Windows PTY owners',
  () => {
    const options = {
      sessionId: 'windows-custom-shell-test',
      cols: 80,
      rows: 24,
      cwd: 'D:\\workspace',
      shellOverride: 'C:\\Portable Tools\\pwsh.exe',
      terminalShellArgs: ['-NoLogo', '-File', 'C:\\My Profile\\start.ps1'],
      terminalWindowsPowerShellImplementation: 'powershell.exe'
    } as const
    const spawn = {
      ...options,
      terminalShellArgs: [...options.terminalShellArgs]
    }

    expect(createPtyShellLaunchPlan(spawn, {})).toMatchObject({
      shellPath: options.shellOverride,
      shellArgs: options.terminalShellArgs,
      windowsFallbackAttempts: []
    })
    expect(
      createLocalPtyLaunchPlan(spawn, () => ({
        getWindowsPowerShellImplementation: () => 'powershell.exe'
      }))
    ).toMatchObject({
      shellPath: options.shellOverride,
      shellArgs: options.terminalShellArgs,
      windowsFallbackAttempts: []
    })
  }
)
