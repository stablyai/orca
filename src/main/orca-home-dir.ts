import { homedir } from 'node:os'
import { join } from 'node:path'
import { ORCA_HOME_DIR_NAME } from '../shared/orca-home'

/** Orca's home on this computer (`~/.orca`), plus optional child segments. */
export function orcaHomeDir(...segments: string[]): string {
  return orcaHomeDirIn(homedir(), ...segments)
}

/** The same directory under an explicit home, for callers that inject it. */
export function orcaHomeDirIn(home: string, ...segments: string[]): string {
  return join(home, ORCA_HOME_DIR_NAME, ...segments)
}
