// Preserve enabled settings; refuse any observable source that could replace the OAuth authority.
import { lstat, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { userInfo } from 'node:os'
import { z } from 'zod'
import type { AgentProfileSnapshot } from '../../shared/agent-launch-profile'
import { AgentProfilePreparationError } from '../agent-profiles/preparation-error'
import { CLAUDE_AUTH_ENV_VARS } from './environment'
import { CLAUDE_PROFILE_PROVIDER_ENV_VARS } from './claude-profile-environment'
import { gitExecFileAsync } from '../git/runner'
import { readGitCommonDir } from '../git/canonical-repo-key'

const objectSchema = z.record(z.string(), z.unknown())
const authorityEnv = new Set<string>([
  ...CLAUDE_AUTH_ENV_VARS,
  ...CLAUDE_PROFILE_PROVIDER_ENV_VARS,
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_CUSTOM_HEADERS'
])

function absent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (absent(error)) {
      return false
    }
    throw new AgentProfilePreparationError('claude_policy')
  }
}
async function settings(path: string): Promise<Record<string, unknown> | null> {
  try {
    const info = await lstat(path)
    if (info.size > 1024 * 1024 || !info.isFile()) {
      throw new Error('unverifiable settings')
    }
    return objectSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    if (absent(error)) {
      return null
    }
    throw new AgentProfilePreparationError('claude_policy')
  }
}
function validateSettings(value: Record<string, unknown> | null): void {
  if (!value) {
    return
  }
  if (['policyHelper', 'policyHelpers'].some((key) => value[key] !== undefined)) {
    throw new AgentProfilePreparationError('claude_policy')
  }
  if (
    [
      'apiKeyHelper',
      'forceLoginGatewayUrl',
      'awsAuthRefresh',
      'awsCredentialExport',
      'gcpAuthRefresh',
      'proxyAuthHelper'
    ].some((key) => value[key] !== undefined) ||
    (value.forceLoginMethod !== undefined && value.forceLoginMethod !== 'claudeai')
  ) {
    throw new AgentProfilePreparationError('claude_config')
  }
  if (value.forceLoginOrgUUID !== undefined) {
    // A policy-selected organization cannot be inferred from an opaque captured subject.
    throw new AgentProfilePreparationError('claude_policy')
  }
  if (value.env !== undefined) {
    const env = objectSchema.safeParse(value.env)
    if (!env.success || Object.keys(env.data).some((key) => authorityEnv.has(key))) {
      throw new AgentProfilePreparationError('claude_config')
    }
  }
}
async function projectSettings(cwd: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const paths = [join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')]
  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-parse', '--show-toplevel', '--git-common-dir'],
      {
        cwd,
        timeout: 5000,
        maxBuffer: 8192,
        env: { ...env, LC_ALL: 'C' }
      }
    )
    const lines = stdout.trim().split('\n')
    const root = lines[0]
    const common = readGitCommonDir(lines.slice(1).join('\n'), cwd)
    if (!root || !common) {
      throw new Error('unverifiable project settings')
    }
    for (const directory of [resolve(cwd, root), dirname(common)]) {
      paths.push(
        join(directory, '.claude', 'settings.json'),
        join(directory, '.claude', 'settings.local.json')
      )
    }
  } catch (error) {
    if (!(error instanceof Error && /not a git repository/.test(error.message))) {
      throw new AgentProfilePreparationError('claude_policy')
    }
  }
  return paths
}
export async function validateManagedClaudeProfileLaunch(
  snapshot: AgentProfileSnapshot,
  context: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<void> {
  if (snapshot.binding.kind !== 'managed') {
    return
  }
  const home = snapshot.resolvedHome
  // Cached remote policy and MDM have provider-owned envelopes/precedence, not plain user JSON.
  if (await exists(join(home, 'remote-settings.json'))) {
    throw new AgentProfilePreparationError('claude_policy')
  }
  if (process.platform === 'darwin') {
    for (const root of [
      '/Library/Managed Preferences',
      join('/Library/Managed Preferences', userInfo().username)
    ]) {
      if (await exists(join(root, 'com.anthropic.claudecode.plist'))) {
        throw new AgentProfilePreparationError('claude_policy')
      }
    }
  }
  if (
    [
      'CLAUDE_CODE_MANAGED_SETTINGS_PATH',
      'CLAUDE_CODE_MOCK_REMOTE_SETTINGS',
      'CLAUDE_CODE_HOST_CREDS_FILE',
      'CLAUDE_CODE_HOST_AUTH_ENV_VAR',
      'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
      'CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR',
      'CLAUDE_CODE_CUSTOM_OAUTH_URL'
    ].some((key) => context.env[key] !== undefined)
  ) {
    throw new AgentProfilePreparationError('claude_policy')
  }
  const policyRoot =
    process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code'
  const paths = [
    join(home, 'settings.json'),
    ...(await projectSettings(context.cwd, context.env)),
    join(policyRoot, 'managed-settings.json')
  ]
  try {
    const entries = await readdir(join(policyRoot, 'managed-settings.d'))
    if (entries.length > 128) {
      throw new Error('unbounded policy')
    }
    paths.push(
      ...entries
        .filter((name) => !name.startsWith('.') && name.endsWith('.json'))
        .map((name) => join(policyRoot, 'managed-settings.d', name))
    )
  } catch (error) {
    if (!absent(error)) {
      throw new AgentProfilePreparationError('claude_policy')
    }
  }
  // Checking each enabled source is conservative across CLI versions and merge precedence.
  for (const path of new Set(paths)) {
    validateSettings(await settings(path))
  }
}
