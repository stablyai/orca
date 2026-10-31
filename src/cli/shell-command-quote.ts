import { quotePosixShell } from '../shared/shell-argument-quoting'

export function quoteCliCommandArgument(value: string): string {
  if (/^[a-zA-Z0-9._:/@-]+$/.test(value)) {
    return value
  }
  if (process.platform === 'win32') {
    return `"${value.replace(/"/g, '\\"')}"`
  }
  return quotePosixShell(value)
}
