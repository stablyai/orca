import { createHash, randomUUID } from 'node:crypto'
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
  /** This chat's own identity values, set on each of its threads' commands instead. */
  chatEnv: Readonly<Record<string, string>>
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
  // Without a version an upgrade can't be told apart (a PATH shim's target changes, its mtime
  // doesn't): never share, so a chat can't be leased a server still running the old binary.
  return codexVersion === null ? [randomUUID()] : [codexVersion, ...mtimes]
}

/** Chats share a server only when the binary, flags, account home, base env and skill roots match. */
export async function codexSharedServerSpec(
  launch: CodexAppServerLaunch,
  skillRoots: readonly string[],
  codexVersion: string | null = null
): Promise<CodexSharedServerSpec> {
  const generation = await launchGeneration(launch, codexVersion)
  // A --config value may be a path Codex resolves from its folder, so such a launch keeps its own.
  const cwd = configValues(launch.args).some((value) => !isOrcaHooksState(value))
    ? launch.cwd
    : homedir()
  const env = { ...launch.env }
  const chatEnv: Record<string, string> = {}
  for (const key of PER_CHAT_ENV_KEYS) {
    const value = env[key]
    if (typeof value === 'string') {
      chatEnv[key] = value
    }
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
    launch: { command: launch.command, args: launch.args, cwd, env, envToDelete },
    chatEnv
  }
}

function configValues(args: readonly string[]): string[] {
  return args.flatMap((arg, index) => {
    if (arg === '-c' || arg === '--config') {
      return [args[index + 1] ?? '']
    }
    const inline = /^(?:--config=|-c=?)(.+)$/.exec(arg)
    return inline ? [inline[1]!] : []
  })
}

const HOOK_STATE_OFF = /"((?:[^"\\]|\\.)*)"=\{enabled=false\}/g

/** Orca's own hooks-off override (`hooks.state={"<absolute hooks.json>:<event>:<g>:<h>"=
 *  {enabled=false},…}`): every entry names a hooks.json by absolute path, so nothing in it
 *  depends on the folder. Any other hooks.state value counts as folder-sensitive. */
function isOrcaHooksState(value: string): boolean {
  const body = /^hooks\.state=\{(.+)\}$/.exec(value)?.[1]
  if (!body || body.replace(HOOK_STATE_OFF, '').replace(/,/g, '') !== '') {
    return false
  }
  return [...body.matchAll(HOOK_STATE_OFF)].every((match) => {
    let trustKey: string
    try {
      trustKey = JSON.parse(`"${match[1]}"`)
    } catch {
      return false
    }
    return isAbsolute(trustKey.split(':').slice(0, -3).join(':'))
  })
}
