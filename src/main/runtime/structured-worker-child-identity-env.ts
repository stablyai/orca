/**
 * Dispatched workers inherit their registered CLI handle. Ordinary chats carry only an origin
 * session reference, validated with the host-issued spawn token; it grants no orchestration identity.
 * Never inject ORCA_PANE_KEY: hook/status readers require it to name an actual PTY leaf.
 */

import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { prependOrcaCliDirToChildPath } from '../cli/orca-cli-child-path'
import { ORCA_STRUCTURED_SESSION_ENV } from '../../shared/structured-session-marker'
import { structuredWorkerIdentities } from './structured-worker-identity'

export function structuredWorkerChildIdentityEnv(
  sessionId: string,
  childEnv: Record<string, string>
): Record<string, string> {
  const identity = structuredWorkerIdentities.getBySessionId(sessionId)
  if (!identity) {
    return {
      ...childEnv,
      ORCA_WORK_ORIGIN_SESSION_ID: sessionId,
      [ORCA_STRUCTURED_SESSION_ENV]: '1'
    }
  }
  const env: Record<string, string> = {
    ...childEnv,
    ORCA_TERMINAL_HANDLE: identity.handle,
    ORCA_CLI_COMMAND: 'orca'
  }
  applyOrcaCliPath(env)
  return env
}

/**
 * A host with no app environment installed — a plain-Node fork, or a unit test — has no userData
 * root to resolve, and inventing one would write a shim into the wrong directory.
 */
function applyOrcaCliPath(env: Record<string, string>): void {
  if (!hasAppEnvironment()) {
    return
  }
  const app = getAppEnvironment()
  prependOrcaCliDirToChildPath(env, {
    isPackaged: app.isPackaged(),
    userDataPath: app.getPath('userData'),
    resourcesPath: process.resourcesPath ?? null
  })
}
