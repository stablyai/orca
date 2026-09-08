/** Child CLI routing identity comes from the host lease; legacy worker handles remain optional. */

import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { prependOrcaCliDirToChildPath } from '../cli/orca-cli-child-path'
import { ORCA_STRUCTURED_SESSION_ENV } from '../../shared/structured-session-marker'
import { structuredWorkerIdentities } from './structured-worker-identity'

export function structuredWorkerChildIdentityEnv(
  sessionId: string,
  childEnv: Record<string, string>,
  runtimeFence?: number
): Record<string, string> {
  const identity = structuredWorkerIdentities.getBySessionId(sessionId)
  const envBase = { ...childEnv }
  delete envBase.ORCA_TERMINAL_HANDLE
  delete envBase.ORCA_PANE_KEY
  delete envBase[ORCA_STRUCTURED_SESSION_ENV]
  delete envBase.ORCA_AGENT_SESSION_ID
  delete envBase.ORCA_AGENT_SESSION_RUNTIME_FENCE
  if (!identity && runtimeFence === undefined) {
    return { ...envBase, [ORCA_STRUCTURED_SESSION_ENV]: '1' }
  }
  const env: Record<string, string> = {
    ...envBase,
    ...(identity ? { ORCA_TERMINAL_HANDLE: identity.handle } : {}),
    ORCA_AGENT_SESSION_ID: sessionId,
    ...(runtimeFence !== undefined
      ? { ORCA_AGENT_SESSION_RUNTIME_FENCE: String(runtimeFence) }
      : {}),
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
