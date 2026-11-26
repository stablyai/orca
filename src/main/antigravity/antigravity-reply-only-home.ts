// Isolated `--gemini-dir` home for reply-only Antigravity runs (Tidy-up): blocks every tool call
// with a PreToolUse deny hook, strict permissions, deny rules, and zero MCP/default customizations.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import { wrapWindowsDirectCmdHookCommand } from '../agent-hooks/installation/commands/windows-direct-cmd-hook-command'
import {
  isSafeUnicodeWindowsBatchHookPath,
  wrapWindowsHookCommand
} from '../agent-hooks/installation/commands/windows-hook-command'
import { REPLY_ONLY_REFUSAL, type ReadOnlySessionMode } from '../bots/bot-look-around-policy'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { copyAgyLoginIntoOrcaHome } from './agy-login-copy'
import { antigravityChatAuthSettingsProjection } from './antigravity-chat-account'
import { antigravityUserHome } from './antigravity-chat-user-skills'
import {
  createVerifiedAntigravityReplyOnlyRunDir,
  sweepAntigravityReplyOnlyHomes
} from './antigravity-reply-only-root'

export { sweepAntigravityReplyOnlyHomes }

/** Safe auth and provider keys copied from the host's agy settings; permission/allow keys are never copied. */
const SAFE_HOST_SETTINGS_KEYS = [
  'auth',
  'modelProvider',
  'gcp',
  'customModelsConfig',
  'useG1Credits'
] as const

const REPLY_ONLY_WINDOWS_HOOK_SCRIPT = 'reply-only-deny.cmd'

export const ANTIGRAVITY_REPLY_ONLY_DENY_RULES = [
  'command(*)',
  'read_file(*)',
  'write_file(*)',
  'read_url(*)',
  'execute_url(*)',
  'mcp(*)'
] as const

const REPLY_ONLY_HOOK_PAYLOAD = JSON.stringify({
  decision: 'deny',
  reason: REPLY_ONLY_REFUSAL
})

/** Windows batch script that prints the static PreToolUse deny JSON cleanly with exit 0. */
export function antigravityReplyOnlyWindowsScript(): string {
  if (/[&|<>^%!()\r\n]/.test(REPLY_ONLY_HOOK_PAYLOAD)) {
    throw new Error('Reply-only hook payload contains unsafe Windows cmd characters')
  }
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    `echo ${REPLY_ONLY_HOOK_PAYLOAD}`,
    'exit /b 0',
    ''
  ].join('\r\n')
}

/** Platform-native PreToolUse deny command: POSIX prints directly; Windows invokes the run-local `.cmd` via Orca's shell-agnostic launcher. */
export function antigravityReplyOnlyHookCommand(
  platform: NodeJS.Platform = process.platform,
  windowsScriptPath?: string
): string {
  if (platform === 'win32') {
    if (!windowsScriptPath) {
      throw new Error('Windows reply-only hook command requires a batch script path')
    }
    return (
      wrapWindowsDirectCmdHookCommand(windowsScriptPath) ??
      wrapWindowsHookCommand(
        windowsScriptPath,
        {},
        {
          useProcessPolicyEnvironment: isSafeUnicodeWindowsBatchHookPath(windowsScriptPath),
          fallbackStdout: REPLY_ONLY_HOOK_PAYLOAD
        }
      )
    )
  }
  const escaped = REPLY_ONLY_HOOK_PAYLOAD.replaceAll("'", "'\\''")
  return `printf '%s\\n' '${escaped}'`
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readSafeHostAuthSettings(userHome: string): Promise<Record<string, unknown>> {
  const path = join(userHome, '.gemini', 'antigravity-cli', 'settings.json')
  const raw = await readFile(path, 'utf8').catch(() => null)
  if (!raw) {
    return {}
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isPlainRecord(parsed)) {
      return {}
    }
    const picked: Record<string, unknown> = {}
    for (const key of SAFE_HOST_SETTINGS_KEYS) {
      if (key in parsed) {
        picked[key] = parsed[key]
      }
    }
    return picked
  } catch {
    return {}
  }
}

export async function prepareAntigravityReplyOnlyLaunch(input: {
  mode: ReadOnlySessionMode
  dataDirectory: string
  env: Readonly<Record<string, string>>
  antigravityChatAuth?: AntigravityChatAuthConfig
  logger?: StructuredAgentSessionLogger
  platform?: NodeJS.Platform
}): Promise<{ args: string[]; cwd: string; release: () => Promise<void> }> {
  if (input.mode !== 'reply-only') {
    throw new Error(`Antigravity does not support ${input.mode} read-only sessions`)
  }
  const platform = input.platform ?? process.platform
  const { homeDir, workDir, release } = await createVerifiedAntigravityReplyOnlyRunDir(
    input.dataDirectory,
    input.logger
  )
  try {
    const appDataDir = join(homeDir, ANTIGRAVITY_ACP_HOME)
    const configDir = join(homeDir, 'config')
    await mkdir(appDataDir, { recursive: true, mode: 0o700 })
    await mkdir(configDir, { recursive: true, mode: 0o700 })

    const userHome = antigravityUserHome(input.env, platform)
    const authSettings = input.antigravityChatAuth
      ? await antigravityChatAuthSettingsProjection(input.antigravityChatAuth, input.env)
      : await readSafeHostAuthSettings(userHome)

    const settings = {
      ...authSettings,
      agentMode: '',
      toolPermission: 'strict',
      allowNonWorkspaceAccess: false,
      permissions: {
        deny: [...ANTIGRAVITY_REPLY_ONLY_DENY_RULES]
      }
    }
    await writeFile(join(appDataDir, 'settings.json'), JSON.stringify(settings), { mode: 0o600 })

    const usesGoogleLogin =
      !input.antigravityChatAuth ||
      input.antigravityChatAuth.method === 'oauth-personal' ||
      input.antigravityChatAuth.method === 'oauth-business'
    await copyAgyLoginIntoOrcaHome(homeDir, userHome, usesGoogleLogin)

    let windowsScriptPath: string | undefined
    if (platform === 'win32') {
      windowsScriptPath = join(configDir, REPLY_ONLY_WINDOWS_HOOK_SCRIPT)
      await writeFile(windowsScriptPath, antigravityReplyOnlyWindowsScript(), { mode: 0o600 })
    }

    const hooks = {
      'orca-reply-only': {
        PreToolUse: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: antigravityReplyOnlyHookCommand(platform, windowsScriptPath)
              }
            ]
          }
        ]
      }
    }
    await writeFile(join(configDir, 'hooks.json'), JSON.stringify(hooks), { mode: 0o600 })

    return {
      args: [
        'acp',
        '--gemini-dir',
        homeDir,
        '--app-data-dir',
        ANTIGRAVITY_ACP_HOME,
        '--include-default-customizations=false'
      ],
      cwd: workDir,
      release
    }
  } catch (error) {
    await release().catch(() => undefined)
    throw error
  }
}
