export function writeStdoutLine(value: string): void {
  process.stdout.write(value.endsWith('\n') ? value : `${value}\n`)
}
