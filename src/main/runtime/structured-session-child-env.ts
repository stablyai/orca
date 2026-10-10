/**
 * The last env step every native-chat child passes (`sealStructuredSessionChild`): Orca's identity
 * for it, its spawn token, and the inherited keys its agent says it must not keep.
 *
 * The orchestration identity — and the CLI reachability — a structured session's own child needs to
 * speak for itself.
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
 * `ORCA_CLI_COMMAND` names that same launcher by absolute path, because a provider can run each
 * command in a login shell (Codex runs `zsh -lc`) whose profile rebuilds PATH and puts a global
 * install ahead of this app's. A bare `orca` that reaches another install still acts as this
 * session: any current CLI sends the injected id and dials the instance `ORCA_USER_DATA_PATH` pins
 * below, and a CLI that predates the id refuses on the marker. When no launcher resolves the key
 * is omitted rather than naming a bare `orca`: on Linux that is GNOME's screen reader, and an
 * inherited value names another app.
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
 * SAME handle rather than a stale or fresh one, and a `/clear` successor bakes its worker's.
 */

import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import {
  ORCA_AGENT_SESSION_ID_ENV,
  ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV
} from '../../shared/agent-session-caller-env'
import {
  ORCA_SCRUB_SAFE_LAUNCH_ENV,
  ORCA_SCRUB_SAFE_PANE_ENV
} from '../../shared/agent-hook-scrub-safe-env'
import { ORCA_STRUCTURED_SESSION_ENV } from '../../shared/structured-session-marker'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { prependOrcaCliDirToChildPath } from '../cli/orca-cli-child-path'
import { AGENT_HOOK_RUNTIME_ENV_KEYS } from '../ipc/pty/host-env/spawn-env-keys'
import { resolveStructuredWorkerIdentityForSession } from './structured-worker-authority'

/**
 * A pane's identity in the inherited environment would let the agent's own Orca status hooks
 * report for this session too; the structured session is its one status producer.
 */
export const STRUCTURED_CHILD_ENV_TO_DELETE: readonly string[] = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN',
  ORCA_SCRUB_SAFE_PANE_ENV,
  ORCA_SCRUB_SAFE_LAUNCH_ENV,
  ...AGENT_HOOK_RUNTIME_ENV_KEYS
]

export type SealedStructuredSessionChild = {
  env: Record<string, string>
  /** Removed from what the child inherits, after `env` is laid over it. */
  envToDelete: string[]
}

/**
 * `env` named as this session's child. `inheritedEnvToDelete` is required so every agent states
 * what it strips, none included; a key the seal itself names the child by is never stripped (a
 * registered worker keeps its handle). `cliRuntimeCommand`: a Node CLI whose own directory goes
 * first on PATH, after the identity's, so it runs on the runtime beside it.
 */
export function sealStructuredSessionChild(input: {
  sessionId: string
  spawnToken: string
  env: Record<string, string>
  inheritedEnvToDelete: readonly string[]
  cliRuntimeCommand?: string
}): SealedStructuredSessionChild {
  const identity = childIdentity(input.sessionId, input.env)
  const named = new Set([
    ORCA_AGENT_SESSION_ID_ENV,
    ORCA_STRUCTURED_SESSION_ENV,
    ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV,
    ...(identity.workerHandle ? ['ORCA_TERMINAL_HANDLE'] : [])
  ])
  const env = input.cliRuntimeCommand
    ? withCliRuntimeOnPath(input.cliRuntimeCommand, identity.env, { platform: process.platform })
    : identity.env
  return {
    env: { ...env, [ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV]: input.spawnToken },
    envToDelete: input.inheritedEnvToDelete.filter((key) => !named.has(key))
  }
}

function childIdentity(
  sessionId: string,
  childEnv: Record<string, string>
): { env: Record<string, string>; workerHandle: string | null } {
  const identity = resolveStructuredWorkerIdentityForSession(sessionId, null)
  const env: Record<string, string> = {
    ...childEnv,
    ...(identity ? { ORCA_TERMINAL_HANDLE: identity.handle } : {}),
    [ORCA_AGENT_SESSION_ID_ENV]: sessionId,
    [ORCA_STRUCTURED_SESSION_ENV]: '1'
  }
  applyThisAppCli(env)
  return { env, workerHandle: identity?.handle ?? null }
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
  const isPackaged = app.isPackaged()
  env.ORCA_USER_DATA_PATH = userDataPath
  const launcher = prependOrcaCliDirToChildPath(env, {
    isPackaged,
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
