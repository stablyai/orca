import { homedir } from 'os'
import { join } from 'path'

export function resolveSshConfigHomePath(filepath: string): string {
  if (filepath === '~') {
    return homedir()
  }
  if (filepath.startsWith('~/') || filepath.startsWith('~\\')) {
    return join(
      homedir(),
      ...filepath
        .slice(2)
        .split(/[\\/]+/)
        .filter(Boolean)
    )
  }
  return filepath
}
