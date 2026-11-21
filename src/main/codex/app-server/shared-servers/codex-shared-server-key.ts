import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import {
  ORCA_AGENT_SESSION_ID_ENV,
  ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV
} from '../../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import {
  LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV,
  NATIVE_CHAT_SCRATCH_DIR_ENV
} from '../../../native-chat/conversation-files/native-chat-visuals-delivery'
import type { CodexAppServerLaunch } from '../codex-app-server-connection'

/** Per-chat keys: each thread gets them through shell_environment_policy.set, never the shared env. */
const PER_CHAT_ENV_KEYS = [
  ORCA_AGENT_SESSION_ID_ENV,
  ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV,
  'ORCA_TERMINAL_HANDLE',
  NATIVE_CHAT_SCRATCH_DIR_ENV,
  LEGACY_NATIVE_CHAT_VISUALS_DIR_ENV
] as const

export type CodexSharedServerSpec = {
  key: string
  launch: CodexAppServerLaunch
}

/** Drain generation: the version this launch's `codex --version` reported, plus the mtimes of the
 *  command and every absolute path it names, so an upgraded Codex gets new servers. */
async function launchGeneration(
  launch: CodexAppServerLaunch,
  codexVersion: string | null
): Promise<unknown[]> {
  const paths = [launch.command, ...launch.args].filter((part) => isAbsolute(part))
  const mtimes = await Promise.all(
    paths.map(async (path) => {
      try {
        return (await stat(path)).mtimeMs
      } catch {
        return null
      }
    })
  )
  return [codexVersion, ...mtimes]
}

/** Chats share a server only when the binary, flags, account home, base env and skill roots match. */
export async function codexSharedServerSpec(
  launch: CodexAppServerLaunch,
  skillRoots: readonly string[],
  codexVersion: string | null = null
): Promise<CodexSharedServerSpec> {
  const generation = await launchGeneration(launch, codexVersion)
  // A --config value may be a path Codex resolves from its folder, so such a launch keeps its own.
  const cwd = launch.args.some(
    (arg) => arg === '--config' || arg.startsWith('--config=') || arg.startsWith('-c')
  )
    ? launch.cwd
    : homedir()
  const env = { ...launch.env }
  for (const key of PER_CHAT_ENV_KEYS) {
    delete env[key]
  }
  const envToDelete = [...new Set([...(launch.envToDelete ?? []), ...PER_CHAT_ENV_KEYS])].sort()
  const key = createHash('sha256')
    .update(
      JSON.stringify({
        command: launch.command,
        generation,
        args: launch.args,
        env: Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        envToDelete,
        skillRoots,
        cwd
      })
    )
    .digest('hex')
  return {
    key,
    // Otherwise the stock CLI runs the same from any folder, and a worktree cwd would pin that
    // folder (Windows can't delete it) for every chat on the server.
    launch: { command: launch.command, args: launch.args, cwd, env, envToDelete }
  }
}
