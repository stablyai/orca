export type WindowsPowerShellImplementation = 'auto' | 'powershell.exe' | 'pwsh.exe'
export type WindowsPowerShellShellFamily =
  | 'powershell.exe'
  | 'pwsh.exe'
  | 'cmd.exe'
  | 'wsl.exe'
  | undefined

export function shouldProbeWindowsPowerShellAvailability(args: {
  shellFamily: WindowsPowerShellShellFamily
  implementation: WindowsPowerShellImplementation | undefined
}): boolean {
  return (
    args.shellFamily === 'powershell.exe' &&
    (args.implementation === undefined || args.implementation === 'auto')
  )
}

/** Resolve which PowerShell executable to spawn right now on Windows.
 *
 * Why: explicit pwsh.exe choices must not be downgraded by a transient cold
 * availability probe; the spawn chain handles true absence with a safe fallback.
 */
export function resolveEffectiveWindowsPowerShell(args: {
  shellFamily: WindowsPowerShellShellFamily
  implementation: WindowsPowerShellImplementation | undefined
  pwshAvailable: boolean
}): 'powershell.exe' | 'pwsh.exe' | null {
  if (args.shellFamily === 'pwsh.exe') {
    return 'pwsh.exe'
  }

  if (args.shellFamily !== 'powershell.exe') {
    return null
  }

  if (args.implementation === 'powershell.exe') {
    return 'powershell.exe'
  }

  if (args.implementation === 'pwsh.exe') {
    return 'pwsh.exe'
  }

  if (args.pwshAvailable) {
    return 'pwsh.exe'
  }

  return 'powershell.exe'
}
