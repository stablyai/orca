import type { WindowsHostInteractiveLoginSpawn } from './windows-interactive-login-spawn'

export function fakeWindowsInteractiveLoginSpawn(
  exitCode: number
): WindowsHostInteractiveLoginSpawn {
  return {
    command: 'cmd.exe',
    args: [],
    stdio: 'ignore',
    windowsHide: false,
    cleanup: async () => {},
    getTerminationPid: () => null,
    waitForTerminationPid: async () => null,
    readExitCode: async () => exitCode
  }
}
