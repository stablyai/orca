import { readFile, realpath, writeFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { claudeStateFile, readClaudeFolderLoginAsync } from './claude-account-folder'
import { readClaudeProfileObject } from '../profiles/claude-profile-paths'
import { isolateClaudeProfileHistory } from '../profiles/setup/claude-profile-private-history'
import { CLAUDE_PROFILE_HISTORY_DIRS } from '../profiles/setup/claude-profile-history'
import { copyProfileHistory } from '../../providers/accounts/profile-history-import'
import { parseClaudeOAuthCredentialsJson } from '../../rate-limits/providers/claude/claude-oauth-credentials'
import {
  readActiveClaudeKeychainCredentialsStrict,
  writeClaudeProfileKeychainCredentials
} from '../runtime-auth/keychain'
import { writeFileAtomically } from '../../filesystem/atomic-file-publication'
import { parseWslUncPath } from '../../../shared/file-access/wsl-paths'

export async function importClaudeHome(
  sourceHome: string,
  destination: string,
  defaultHome: string,
  importHistory: boolean
): Promise<void> {
  if (parseWslUncPath(sourceHome) || parseWslUncPath(destination)) {
    throw new Error(
      'Import Claude profiles on their native host. Use the WSL sign-in flow for a WSL account.'
    )
  }
  const source = await realpath(resolve(sourceHome.trim()))
  const statePath = claudeStateFile(source)
  const login = await readClaudeFolderLoginAsync(statePath)
  const state = readClaudeProfileObject(statePath)
  if (!login || state.kind !== 'present') {
    throw new Error('The source Claude profile has no account identity. Sign in there first.')
  }
  let credentials: string | null = null
  if (process.platform === 'darwin') {
    credentials = await readActiveClaudeKeychainCredentialsStrict(resolve(sourceHome.trim()))
    const systemHome = await realpath(join(homedir(), '.claude')).catch(() => null)
    if (!credentials && source === systemHome) {
      credentials = await readActiveClaudeKeychainCredentialsStrict()
    }
  }
  credentials ??= await readFile(join(source, '.credentials.json'), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  })
  const parsed = credentials
    ? parseClaudeOAuthCredentialsJson(credentials, 'credentials-file')
    : null
  if (!credentials || (!parsed?.token && !parsed?.hasRefreshableCredentials)) {
    throw new Error('The source Claude profile has no usable OAuth login. Sign in there first.')
  }
  await isolateClaudeProfileHistory(destination, defaultHome)
  if (importHistory) {
    await unlink(join(destination, 'history.jsonl')).catch((error) => {
      if (error.code !== 'ENOENT') {
        throw error
      }
    })
    await copyProfileHistory(source, destination, [...CLAUDE_PROFILE_HISTORY_DIRS, 'history.jsonl'])
  }
  const destinationState = claudeStateFile(destination)
  const existing = readClaudeProfileObject(destinationState)
  writeFileAtomically(
    destinationState,
    JSON.stringify({
      ...(existing.kind === 'present' ? existing.value : {}),
      oauthAccount: state.value.oauthAccount,
      hasCompletedOnboarding: true
    }),
    { mode: 0o600 }
  )
  await (process.platform === 'darwin'
    ? writeClaudeProfileKeychainCredentials(destination, credentials)
    : writeFile(join(destination, '.credentials.json'), credentials, { mode: 0o600 }))
}
