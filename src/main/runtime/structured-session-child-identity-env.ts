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
 * The PATH prepend below makes bare `orca` this app's CLI, the SAME function `buildPtyHostEnv`
 * applies, rather than a second, drifting copy of the rule. Orca's Linux CLI installs as `orca-ide`
 * so it never claims GNOME Orca's /usr/bin/orca (stablyai/orca#7904), and on packaged macOS/Windows
 * the bundled launcher is reachable only from the app's own resources dir.
 *
 * `ORCA_CLI_COMMAND` is the absolute launcher in that directory, because a provider can run each
 * command in a login shell (Codex runs `zsh -lc`), whose profile rebuilds PATH and puts a global
 * install — possibly an older Orca — ahead of this app's. A current CLI reached that way re-runs
 * itself as this launcher (`src/cli/session-cli-reexec.ts`), so an agent that types bare `orca` still acts
 * through this app's CLI. When no launcher resolves the key is omitted rather than set to a bare
 * name: on Linux a bare `orca` is GNOME's screen reader, and an inherited value names another app.
 *
 * `ORCA_USER_DATA_PATH` pins this instance beside the identity, so any current CLI — the session's
 * own or a global one — dials the Orca that minted the id instead of the production default.
 *
 * Deliberately NOT `ORCA_PANE_KEY`. Claude structured sessions run hooks, and a pane key in their
 * environment starts flowing into hook-emitted agent-status payloads and the hook-attestation,
 * agent-row and mobile-projection pipelines, every one of which assumes a pane key names a live
 * PTY leaf. It would also open `selectExactWorkerProviderSession`, which is fail-closed today
 * precisely because a structured session emits no hook agent status.
 *
 * `ORCA_STRUCTURED_SESSION` stays beside the id for a CLI that predates it — one reached through a
 * global install when a shell rc resets PATH — which would otherwise guess a sibling's terminal;
 * such a CLI refuses on the marker. A current CLI checks the id first, so the marker never makes a
 * session with an id identity-less.
 *
 * The handle is read from the registry at spawn time, so an in-host recovery respawn re-bakes the
 * SAME handle rather than a stale or fresh one.
 */

import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { ORCA_AGENT_SESSION_ID_ENV } from '../../shared/agent-session-caller-env'
import { ORCA_STRUCTURED_SESSION_ENV } from '../../shared/structured-session-marker'
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
    [ORCA_STRUCTURED_SESSION_ENV]: '1'
  }
  applyThisAppCli(env)
  return env
}

/**
 * A host with no app environment installed — a plain-Node fork, or a unit test — has no userData
 * root to resolve, and inventing one would write a shim into the wrong directory.
 */
function applyThisAppCli(env: Record<string, string>): void {
  delete env.ORCA_CLI_COMMAND
  if (!hasAppEnvironment()) {
    return
  }
  const app = getAppEnvironment()
  const userDataPath = app.getPath('userData')
  env.ORCA_USER_DATA_PATH = userDataPath
  const launcher = prependOrcaCliDirToChildPath(env, {
    isPackaged: app.isPackaged(),
    userDataPath,
    resourcesPath: process.resourcesPath ?? null
  })
  if (launcher) {
    env.ORCA_CLI_COMMAND = launcher
  } else {
    console.warn(
      "[structured-session] This app's CLI launcher did not resolve; the session's child has no ORCA_CLI_COMMAND."
    )
  }
}
