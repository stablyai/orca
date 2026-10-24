import type { ResolvedCommand } from './wsl-command-resolution'

/** wsl.exe's own launch-failure exit, distinct from any status the guest process can return. */
export const WSL_HOST_FAILURE_EXIT_CODE = 0xffffffff

function outputText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  return Buffer.isBuffer(value) ? value.toString('utf8') : ''
}

/** Decode WSL launch diagnostics from stdout, stripping UTF-16LE NULs when WSL_UTF8 was ignored. */
export function readWslHostFailureDiagnostic(
  error: unknown,
  command: ResolvedCommand
): string | null {
  if (!command.wsl || !error || typeof error !== 'object') {
    return null
  }
  const { code, status, stdout, stderr } = error as {
    code?: unknown
    status?: unknown
    stdout?: unknown
    stderr?: unknown
  }
  const exitCode = typeof code === 'number' ? code : typeof status === 'number' ? status : null
  // Recognize the host launch-failure shape without reclassifying guest stderr.
  if (exitCode !== WSL_HOST_FAILURE_EXIT_CODE || outputText(stderr).trim().length > 0) {
    return null
  }
  const diagnostic = outputText(stdout).replaceAll('\u0000', '').trim()
  return diagnostic.length > 0 ? diagnostic : 'wsl.exe reported no diagnostic.'
}

/** Put WSL launch diagnostics in the message recorded by git.exec; preserve guest errors. */
export function annotateWslHostFailure(error: unknown, command: ResolvedCommand): unknown {
  const diagnostic = readWslHostFailureDiagnostic(error, command)
  if (diagnostic === null || !(error instanceof Error) || !command.wsl) {
    return error
  }
  const distro = command.wsl.distro
  error.message = `wsl.exe host failure (distro "${distro}"): ${diagnostic}\n${error.message}`
  return Object.assign(error, { wslHostFailure: true, wslDistro: distro })
}
