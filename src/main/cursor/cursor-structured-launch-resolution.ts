import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'
import { structuredAgentBaseEnvironment } from '../runtime/structured-agent-shell-environment'
import { nativeChatShellEnvironmentPolicy } from '../../shared/native-chat-shell-environment'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { structuredSessionChildIdentityEnv } from '../runtime/structured-session-child-identity-env'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import { tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import {
  supportsCursorStructuredLocation,
  type CursorStructuredLaunch
} from './cursor-structured-session-adapter'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'

export type CursorStructuredLaunchRecipe = {
  command?: string
  args?: string
  env?: Record<string, string>
}

export function cursorStructuredAccountHome(launchEnv: NodeJS.ProcessEnv): string {
  return (
    launchEnv.CURSOR_CONFIG_DIR?.trim() ||
    (launchEnv.XDG_CONFIG_HOME?.trim()
      ? join(launchEnv.XDG_CONFIG_HOME.trim(), 'cursor')
      : join(launchEnv.HOME?.trim() || launchEnv.USERPROFILE?.trim() || homedir(), '.cursor'))
  )
}

export async function resolveCursorStructuredAccountHome(
  overlay: Record<string, string>,
  settings: Pick<
    GlobalSettings,
    'nativeChatInheritShellEnvironment' | 'nativeChatShellEnvironmentVariables'
  >,
  resolveEnvironment = resolveLoginShellEnvironment
): Promise<string> {
  const base = structuredAgentBaseEnvironment({
    shellEnv: await resolveEnvironment(),
    policy: nativeChatShellEnvironmentPolicy(settings)
  })
  return cursorStructuredAccountHome({ ...base, ...overlay })
}

export function createCursorStructuredLaunchResolver(deps: {
  store: Pick<AgentSessionRecordStore, 'getRecord'>
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  resolveEnvironment: () => Promise<NodeJS.ProcessEnv>
  resolveRecipe?: () => CursorStructuredLaunchRecipe
}): (input: StructuredAgentSessionAcquireInput) => Promise<CursorStructuredLaunch> {
  return async ({ identity }) => {
    const record = deps.store.getRecord(identity.sessionId)
    if (
      !record ||
      record.provider !== 'cursor' ||
      record.accountHome.variable !== 'CURSOR_CONFIG_DIR' ||
      !supportsCursorStructuredLocation(record.location)
    ) {
      throw new Error(
        'Cursor session must belong to this execution host and pin its Cursor config directory'
      )
    }
    const environment = await deps.resolveEnvironment()
    const recipe = deps.resolveRecipe?.() ?? {}
    const shell = process.platform === 'win32' ? 'powershell' : 'posix'
    const command = tokenizeStartupCommand(recipe.command?.trim() || 'cursor-agent', shell)
    const args = tokenizeStartupCommand(recipe.args?.trim() || '', shell)
    if (!command.ok || !args.ok || !command.tokens[0]) {
      throw new Error('Cursor configured launch command could not be parsed')
    }
    const cliArgs = [...command.tokens.slice(1), ...args.tokens]
    if (
      cliArgs.some(
        (arg) =>
          ['--resume', '-r', '--continue', '--print', '-p', 'acp', 'resume', '--'].includes(arg) ||
          arg.startsWith('--resume=')
      )
    ) {
      throw new Error(
        'Cursor terminal continuation arguments cannot be applied to a native ACP session'
      )
    }
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(environment)) {
      if (value !== undefined) {
        env[key] = value
      }
    }
    Object.assign(env, recipe.env, { CURSOR_CONFIG_DIR: record.accountHome.path })
    const head = record.providerHandleChain.at(-1)
    if (head && head.handle.provider !== 'cursor') {
      throw new Error('Cursor record has another provider handle')
    }
    return {
      command: resolveCliCommand(command.tokens[0], {
        pathEnv: env.PATH ?? env.Path,
        homePath: env.HOME ?? env.USERPROFILE
      }),
      args: [...cliArgs, 'acp'],
      env: structuredSessionChildIdentityEnv(identity.sessionId, env),
      cwd: await deps.resolveWorkspacePath(record.location.workspaceId),
      ...(head?.handle.provider === 'cursor' ? { resumeSessionId: head.handle.sessionId } : {})
    }
  }
}
