import { readFileSync } from 'node:fs'

/** The daemon's auth token, or '' when it is missing so the endpoint is still probed. */
export function readDaemonClientToken(tokenPath: string): string {
  try {
    return readFileSync(tokenPath, 'utf-8').trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return ''
    }
    throw error
  }
}
