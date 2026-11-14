import { join, sep } from 'node:path'

export function expandLeadingHomePath(input: string, home: string): string {
  if (input === '~') {
    return home
  }
  if (input.startsWith(`~${sep}`) || (process.platform === 'win32' && input.startsWith('~/'))) {
    return join(home, input.slice(2))
  }
  return input
}
