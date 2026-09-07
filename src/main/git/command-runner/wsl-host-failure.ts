import type { ResolvedCommand } from './wsl-command-resolution'

/** wsl.exe's own launch-failure exit, distinct from any status the guest process can return. */
export const WSL_HOST_FAILURE_EXIT_CODE = 0xffffffff

function outputText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  return Buffer.isBuffer(value) ? value.toString('utf8') : ''
}

/**
 * The message wsl.exe prints when it — not the guest — failed: a distro that was renamed or
 * removed, or a VM that would not start.
 *
 * Why this needs decoding at all: wsl.exe exits 0xFFFFFFFF, leaves stderr EMPTY, and writes
 * `Error code: Wsl/Service/WSL_E_*` to stdout, so every caller that reports stderr reports nothing.
 * NULs are stripped because a wsl.exe that ignores WSL_UTF8 writes that line as UTF-16LE (#9010).
 */
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
  // A guest failure always explains itself on stderr; an empty one plus this exit is the host.
  if (exitCode !== WSL_HOST_FAILURE_EXIT_CODE || outputText(stderr).trim().length > 0) {
    return null
  }
  const diagnostic = outputText(stdout).replaceAll('\u0000', '').trim()
  return diagnostic.length > 0 ? diagnostic : 'wsl.exe reported no diagnostic.'
}

/**
 * Move a wsl.exe host failure into the error's message, which is what `git.exec` spans record ahead
 * of the stack. Left untouched when the failure came from git itself.
 */
export function annotateWslHostFailure(error: unknown, command: ResolvedCommand): unknown {
  const diagnostic = readWslHostFailureDiagnostic(error, command)
  if (diagnostic === null || !(error instanceof Error) || !command.wsl) {
    return error
  }
  const distro = command.wsl.distro
  error.message = `wsl.exe host failure (distro "${distro}"): ${diagnostic}\n${error.message}`
  return Object.assign(error, { wslHostFailure: true, wslDistro: distro })
}
