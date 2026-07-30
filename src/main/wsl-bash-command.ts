/** Single-quote a value for safe interpolation into a Bash command line. */
export function quoteBashString(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function buildEncodedWslBashCommand(command: string): string {
  // Why: wsl.exe preprocesses `$local_shell_vars` in command arguments before
  // Bash sees them. Base64 keeps validation scripts intact across that boundary.
  const encoded = Buffer.from(command, 'utf8').toString('base64')
  return `set -o pipefail; printf %s ${quoteBashString(encoded)} | base64 -d | bash`
}
