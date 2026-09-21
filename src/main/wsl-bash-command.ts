// Why re-export rather than redefine: POSIX single-quote escaping had four
// byte-identical copies in this tree. One of them is enough.
import { quotePosixShell } from '../shared/wsl-login-shell-command'

export { quotePosixShell as quoteBashString }

export function buildEncodedWslBashCommand(command: string): string {
  // Why: keeps a multi-line validation script intact as a single argument, and
  // keeps quoting out of the caller's hands. (argv itself now survives verbatim
  // via --exec; this is about the payload, not the wsl.exe boundary.)
  const encoded = Buffer.from(command, 'utf8').toString('base64')
  return `set -o pipefail; printf %s ${quotePosixShell(encoded)} | base64 -d | bash`
}
