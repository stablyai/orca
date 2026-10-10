import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  isOrcaHomeDirName,
  ORCA_RELAY_HOME_DIR_ENV,
  ORCA_REMOTE_HOME_DIR_NAME
} from '../shared/orca-home'

/** The directory name the relay uses on its host: `.orca` unless the client
 *  launched it with a valid ORCA_RELAY_HOME_DIR_NAME. */
export function relayOrcaHomeDirName(env: NodeJS.ProcessEnv = process.env): string {
  const requested = env[ORCA_RELAY_HOME_DIR_ENV]
  return requested && isOrcaHomeDirName(requested) ? requested : ORCA_REMOTE_HOME_DIR_NAME
}

/** The relay's Orca home on the host it runs on, plus optional child segments. */
export function relayOrcaHomeDir(home: string = homedir(), ...segments: string[]): string {
  return join(home, relayOrcaHomeDirName(), ...segments)
}
