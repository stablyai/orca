/** Single-quote a value for safe interpolation into a Bash command line. */
export function quoteBashString(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function buildEncodedWslBashCommand(command: string): string {
  // Why: keeps a multi-line validation script intact as a single argument, and
  // keeps quoting out of the caller's hands. (argv itself now survives verbatim
  // via --exec; this is about the payload, not the wsl.exe boundary.)
  const encoded = Buffer.from(command, 'utf8').toString('base64')
  return `set -o pipefail; printf %s ${quoteBashString(encoded)} | base64 -d | bash`
}
