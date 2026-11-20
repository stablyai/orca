import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute } from 'node:path'
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

const CODEX_EXECUTABLE = /^codex(?:\.exe|\.cmd|\.ps1|\.js|\.mjs)?$/i
const NODE_EXECUTABLE = /^node(?:\.exe)?$/i
const RELATIVE_PATH = /^\.\.?[\\/]/

/** Only a launch that runs Codex itself (by absolute path or PATH, directly or through node) with no
 *  ./relative argument runs the same from any folder; a wrapper keeps the chat's folder and shares
 *  only with chats in that folder. */
function isFolderIndependent(launch: CodexAppServerLaunch): boolean {
  const program = basename(launch.command)
  const runsCodex =
    CODEX_EXECUTABLE.test(program) ||
    (NODE_EXECUTABLE.test(program) &&
      launch.args[0] !== undefined &&
      isAbsolute(launch.args[0]) &&
      CODEX_EXECUTABLE.test(basename(launch.args[0])))
  const relativeCommand = !isAbsolute(launch.command) && /[\\/]/.test(launch.command)
  return (
    runsCodex &&
    !relativeCommand &&
    ![launch.command, ...launch.args].some((part) => RELATIVE_PATH.test(part))
  )
}

/** Chats share a server only when the binary, flags, account home, base env and skill roots match. */
export async function codexSharedServerSpec(
  launch: CodexAppServerLaunch,
  skillRoots: readonly string[],
  codexVersion: string | null = null
): Promise<CodexSharedServerSpec> {
  const generation = await launchGeneration(launch, codexVersion)
  const env = { ...launch.env }
  for (const key of PER_CHAT_ENV_KEYS) {
    delete env[key]
  }
  const envToDelete = [...new Set([...(launch.envToDelete ?? []), ...PER_CHAT_ENV_KEYS])].sort()
  // A worktree cwd would pin that folder (Windows can't delete it) for every chat on the server.
  const cwd = isFolderIndependent(launch) ? homedir() : launch.cwd
  const key = createHash('sha256')
    .update(
      JSON.stringify({
        command: launch.command,
        generation,
        args: launch.args,
        cwd: cwd === homedir() ? null : (cwd ?? null),
        env: Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        envToDelete,
        skillRoots
      })
    )
    .digest('hex')
  return {
    key,
    launch: {
      command: launch.command,
      args: launch.args,
      ...(cwd ? { cwd } : {}),
      env,
      envToDelete
    }
  }
}
