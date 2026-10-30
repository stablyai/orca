import { quotePosixShell } from '../shared/shell-argument-quoting'

export { quotePosixShell as quoteBashString }

export function buildEncodedWslBashCommand(command: string): string {
  // Encode multiline payloads intact; --exec separately preserves the wsl.exe argument boundary.
  const encoded = Buffer.from(command, 'utf8').toString('base64')
  return `set -o pipefail; printf %s ${quotePosixShell(encoded)} | base64 -d | bash`
}
