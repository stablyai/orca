/**
 * The orchestration identity — and the CLI reachability — a structured session's own child needs to
 * speak for itself. Both providers' native launches (Claude, Codex) build their child env here.
 *
 * Every structured session carries `ORCA_AGENT_SESSION_ID`, the id Orca minted for it — never the
 * provider's, which rotates on `/clear`. The CLI sends it as the caller, so a bare
 * `orca orchestration check` acts as this session instead of guessing a terminal: with no pane of
 * its own, every guess landed on a sibling, and a destructive `check` consumed that sibling's mail.
 * Identity by session id assumes one machine and one user; crossing a host boundary (SSH, a paired
 * peer) re-opens that decision, and the host refuses a session claim from across one.
 *
 * A dispatched structured worker also keeps the `structworker_` handle it was minted, for the
 * handle-based surfaces outside orchestration; for orchestration the id wins and the host maps it
 * back to that handle, so the worker keeps one identity.
 *
 * `ORCA_CLI_COMMAND: 'orca'` is honest ONLY because of the PATH prepend below. Orca's Linux CLI
 * installs as `orca-ide` so it never claims GNOME Orca's /usr/bin/orca (stablyai/orca#7904), and
 * on packaged macOS/Windows the bundled launcher is reachable only from the app's own resources
 * dir. A PTY agent gets that treatment from `buildPtyHostEnv`; a structured session has no PTY, so
 * it applies the SAME function here rather than a second, drifting copy of the rule.
 *
 * Deliberately NOT `ORCA_PANE_KEY`. Claude structured sessions run hooks, and a pane key in their
 * environment starts flowing into hook-emitted agent-status payloads and the hook-attestation,
 * agent-row and mobile-projection pipelines, every one of which assumes a pane key names a live
 * PTY leaf. It would also open `selectExactWorkerProviderSession`, which is fail-closed today
 * precisely because a structured session emits no hook agent status.
 *
 * The identity-less marker (`ORCA_STRUCTURED_SESSION`) is no longer written: a child with an id is
 * never identity-less, so a marker inherited from an Orca launched inside an older session is inert.
 *
 * The handle is read from the registry at spawn time, so an in-host recovery respawn re-bakes the
 * SAME handle rather than a stale or fresh one.
 */

import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { ORCA_AGENT_SESSION_ID_ENV } from '../../shared/agent-session-caller-env'
import { prependOrcaCliDirToChildPath } from '../cli/orca-cli-child-path'
import { structuredWorkerIdentities } from './structured-worker-identity'

export function structuredSessionChildIdentityEnv(
  sessionId: string,
  childEnv: Record<string, string>
): Record<string, string> {
  const identity = structuredWorkerIdentities.getBySessionId(sessionId)
  const env: Record<string, string> = {
    ...childEnv,
    ...(identity ? { ORCA_TERMINAL_HANDLE: identity.handle } : {}),
    [ORCA_AGENT_SESSION_ID_ENV]: sessionId,
    ORCA_CLI_COMMAND: 'orca'
  }
  applyOrcaCliPath(env)
  return env
}

/**
 * The same session id for its terminal view, so switching views never changes who the session is.
 * Same-host only, as above: the host refuses the claim from a terminal that runs in WSL or over SSH.
 * A terminal that is not a session's view keeps its env exactly as given.
 */
export function withStructuredSessionTerminalViewEnv(
  env: Record<string, string> | undefined,
  sessionId: string | undefined
): Record<string, string> | undefined {
  return sessionId ? { ...env, [ORCA_AGENT_SESSION_ID_ENV]: sessionId } : env
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
