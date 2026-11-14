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

/** Preserve explicit pwsh choice through transient availability failures; spawn fallbacks handle genuine absence. */
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
