// Windows 11's inbox wsl.exe stub opens the WSL installer and a UAC prompt on every call.
// Once a service query proves WSL is absent, no wsl.exe call may run for the rest of the process.
export const WSL_NOT_INSTALLED_CODE = 'ENOENT'

let wslNotInstalled = false

function isWslProgram(program: string): boolean {
  const base = program.slice(Math.max(program.lastIndexOf('/'), program.lastIndexOf('\\')) + 1)
  const lower = base.toLowerCase()
  return lower === 'wsl' || lower === 'wsl.exe'
}

export function latchWslNotInstalled(): void {
  wslNotInstalled = true
}

export function isWslNotInstalledLatched(): boolean {
  return wslNotInstalled
}

/** Throw an ENOENT before a wsl.exe spawn on a host known to have no WSL install. */
export function assertWslNotLatchedAbsent(program: string): void {
  if (wslNotInstalled && isWslProgram(program)) {
    throw Object.assign(new Error('wsl.exe not spawned: WSL is not installed'), {
      code: WSL_NOT_INSTALLED_CODE
    })
  }
}

export function _resetWslNotInstalledLatchForTests(): void {
  wslNotInstalled = false
}
