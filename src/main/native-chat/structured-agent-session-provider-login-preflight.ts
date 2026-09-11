import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'

/**
 * Three answers, not two. A structured create resolves the account home itself and never runs the
 * terminal lane's credential preparation, so a host with no login spawns a child that fails its
 * auth mid-stream with nothing to show for it. Refusing needs a positively observed empty account
 * home: an unreadable probe is loss of evidence, not evidence of absence.
 */
export type StructuredProviderLoginVerdict = 'present' | 'missing' | 'unverifiable'

const CLAUDE_CREDENTIAL_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN'
] as const

const CODEX_CREDENTIAL_ENV = ['CODEX_API_KEY', 'OPENAI_API_KEY'] as const

const CREDENTIAL_FILE = { claude: '.credentials.json', codex: 'auth.json' } as const

/** The Claude config directory a structured create launches under. */
export function resolveStructuredClaudeAccountHomePath(input: {
  launchEnv: NodeJS.ProcessEnv
  managedConfigDir: string | null | undefined
}): string {
  return (
    input.launchEnv.CLAUDE_CONFIG_DIR?.trim() ||
    input.managedConfigDir?.trim() ||
    join(homedir(), '.claude')
  )
}

/**
 * The Codex home a structured create launches under, or null when only preparing it would reveal
 * it. Preparing is a side effect and a support probe may not have one, so the caller answers
 * unverifiable there rather than probing the system home the launch would not have used.
 */
export function resolveStructuredCodexPreflightHomePath(input: {
  launchEnv: NodeJS.ProcessEnv
  homeIsPreparedAtLaunch: boolean
}): string | null {
  if (input.homeIsPreparedAtLaunch) {
    return null
  }
  return input.launchEnv.CODEX_HOME?.trim() || getSystemCodexHomePath()
}

function hasCredentialEnv(env: NodeJS.ProcessEnv, agent: 'claude' | 'codex'): boolean {
  const names = agent === 'claude' ? CLAUDE_CREDENTIAL_ENV : CODEX_CREDENTIAL_ENV
  return names.some((name) => (env[name] ?? '').trim().length > 0)
}

function isMissingEntry(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

type FileRead = { kind: 'present'; contents: string } | { kind: 'absent' } | { kind: 'unreadable' }

/** The same three answers one level down: an empty file is absent, an errno that is not ENOENT
 *  is unreadable. */
async function readNonEmptyFile(path: string): Promise<FileRead> {
  try {
    const contents = await readFile(path, 'utf-8')
    return contents.trim().length > 0 ? { kind: 'present', contents } : { kind: 'absent' }
  } catch (error) {
    return isMissingEntry(error) ? { kind: 'absent' } : { kind: 'unreadable' }
  }
}

/** Claude also authenticates through a helper command or a per-directory env block. */
function claudeSettingsGrantAuth(contents: string): boolean {
  const parsed: unknown = JSON.parse(contents)
  if (!parsed || typeof parsed !== 'object') {
    return false
  }
  const settings = parsed as { apiKeyHelper?: unknown; env?: unknown }
  if (typeof settings.apiKeyHelper === 'string' && settings.apiKeyHelper.trim().length > 0) {
    return true
  }
  return typeof settings.env === 'object' && settings.env !== null
    ? hasCredentialEnv(settings.env as NodeJS.ProcessEnv, 'claude')
    : false
}

/** `present` when the settings grant auth, `unverifiable` when they cannot be read or parsed. */
async function claudeSettingsVerdict(
  accountHomePath: string
): Promise<'present' | 'unverifiable' | null> {
  const settings = await readNonEmptyFile(join(accountHomePath, 'settings.json'))
  if (settings.kind === 'absent') {
    return null
  }
  if (settings.kind === 'unreadable') {
    return 'unverifiable'
  }
  try {
    return claudeSettingsGrantAuth(settings.contents) ? 'present' : null
  } catch {
    // Settings that will not parse could carry either answer.
    return 'unverifiable'
  }
}

/** True only when the home is there to look in and holds no login, or was never created at all.
 *  Any other errno rethrows, because a home we cannot read is not a home we can call empty. */
async function accountHomeProvesNoLogin(accountHomePath: string): Promise<boolean> {
  try {
    return (await stat(accountHomePath)).isDirectory()
  } catch (error) {
    if (isMissingEntry(error)) {
      // No account home at all: the provider was never signed in on this host.
      return true
    }
    throw error
  }
}

/**
 * Whether the executing host holds a login for the provider a create would spawn. Reads only; it
 * never prepares a home, spawns the provider, or touches the keychain.
 */
export async function probeStructuredAgentSessionProviderLogin(input: {
  agent: 'claude' | 'codex'
  accountHomePath: string | null
  env: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}): Promise<StructuredProviderLoginVerdict> {
  if (hasCredentialEnv(input.env, input.agent)) {
    return 'present'
  }
  if (input.accountHomePath === null) {
    return 'unverifiable'
  }
  try {
    const credentials = await readNonEmptyFile(
      join(input.accountHomePath, CREDENTIAL_FILE[input.agent])
    )
    if (credentials.kind !== 'absent') {
      return credentials.kind === 'present' ? 'present' : 'unverifiable'
    }
    if (input.agent === 'claude') {
      const fromSettings = await claudeSettingsVerdict(input.accountHomePath)
      if (fromSettings) {
        return fromSettings
      }
      if ((input.platform ?? process.platform) === 'darwin') {
        // The Claude login lives in the login keychain here, which this deliberately does not
        // open: an absent credentials file proves nothing on macOS.
        return 'unverifiable'
      }
    }
    return (await accountHomeProvesNoLogin(input.accountHomePath)) ? 'missing' : 'unverifiable'
  } catch {
    return 'unverifiable'
  }
}
