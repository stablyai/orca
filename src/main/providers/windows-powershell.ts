export type WindowsPowerShellImplementation = 'auto' | 'powershell.exe' | 'pwsh.exe'

/** Resolve which PowerShell executable to spawn right now on Windows.
 *
 * Why: keep the saved pwsh preference intact even when pwsh is temporarily
 * unavailable, so runtime falls back safely without mutating user settings.
 */
export function resolveEffectiveWindowsPowerShell(args: {
  shellFamily: 'powershell.exe' | 'cmd.exe' | 'wsl.exe' | undefined
  implementation: WindowsPowerShellImplementation | undefined
  pwshAvailable: boolean
}): 'powershell.exe' | 'pwsh.exe' | null {
  if (args.shellFamily !== 'powershell.exe') {
    return null
  }

  if (
    (args.implementation === undefined ||
      args.implementation === 'auto' ||
      args.implementation === 'pwsh.exe') &&
    args.pwshAvailable
  ) {
    return 'pwsh.exe'
  }

  return 'powershell.exe'
}
