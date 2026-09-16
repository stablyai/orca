/** Write one newline-terminated payload to stdout without doubling an existing newline. */
export function writeStdoutLine(value: string): void {
  process.stdout.write(value.endsWith('\n') ? value : `${value}\n`)
}
