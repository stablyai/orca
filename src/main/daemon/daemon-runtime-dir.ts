import { join } from 'node:path'

/** The daemon runtime dir of a server serving this data root. */
export function daemonRuntimeDirFor(userDataPath: string): string {
  return join(userDataPath, 'daemon')
}
