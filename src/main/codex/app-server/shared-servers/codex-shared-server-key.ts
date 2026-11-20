import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
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

/** Binary mtime is the drain generation: an upgraded Codex gets new servers; old ones drain. */
function binaryGeneration(command: string): number | null {
  try {
    return statSync(command).mtimeMs
  } catch {
    return null
  }
}

/** Chats share a server only when the binary, flags, account home, base env and skill roots match. */
export function codexSharedServerSpec(
  launch: CodexAppServerLaunch,
  skillRoots: readonly string[]
): CodexSharedServerSpec {
  const env = { ...launch.env }
  for (const key of PER_CHAT_ENV_KEYS) {
    delete env[key]
  }
  const envToDelete = [...new Set([...(launch.envToDelete ?? []), ...PER_CHAT_ENV_KEYS])].sort()
  const key = createHash('sha256')
    .update(
      JSON.stringify({
        command: launch.command,
        generation: binaryGeneration(launch.command),
        args: launch.args,
        env: Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        envToDelete,
        skillRoots
      })
    )
    .digest('hex')
  return {
    key,
    // A worktree cwd would pin that folder (Windows can't delete it) for every chat on the server.
    launch: { command: launch.command, args: launch.args, cwd: homedir(), env, envToDelete }
  }
}
