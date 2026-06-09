export function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function powerShellCommand(script: string): string {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
}
