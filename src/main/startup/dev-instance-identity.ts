import { createHash } from 'node:crypto'
import path from 'node:path'
import type { AppIdentity } from '../../shared/app-identity'

const BASE_APP_NAME = 'Orca'
const BASE_APP_USER_MODEL_ID = 'com.stablyai.orca'
const MAX_LABEL_LENGTH = 80

export type DevInstanceIdentity = AppIdentity & {
  appUserModelId: string
  // Why: drives app.setName → the macOS safeStorage Keychain item name
  // ("<appName> Safe Storage"). Kept stable across dev branches (unlike the
  // per-branch `name`) so every dev instance shares one Keychain key instead of
  // creating a new one per branch and re-prompting. Distinct from prod's 'Orca'.
  appName: string
}

function cleanEnvValue(value: string | undefined): string | null {
  const trimmed = value?.replace(/\s+/g, ' ').trim()
  if (!trimmed) {
    return null
  }
  return trimmed.length > MAX_LABEL_LENGTH
    ? `${trimmed.slice(0, MAX_LABEL_LENGTH - 3)}...`
    : trimmed
}

function lastPathSegment(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  return normalized.split('/').findLast(Boolean) ?? value
}

function formatLabel(branch: string | null, worktreeName: string | null): string | null {
  if (branch && worktreeName) {
    if (branch === worktreeName || lastPathSegment(branch) === worktreeName) {
      return worktreeName
    }
    return `${worktreeName} @ ${branch}`
  }
  return branch ?? worktreeName
}

function createDevAppUserModelId(identityKey: string | null): string {
  if (!identityKey) {
    return BASE_APP_USER_MODEL_ID
  }
  const hash = createHash('sha1').update(identityKey).digest('hex').slice(0, 10)
  return `${BASE_APP_USER_MODEL_ID}.dev.${hash}`
}

export function getDevInstanceIdentity(
  isDev: boolean,
  env: NodeJS.ProcessEnv = process.env
): DevInstanceIdentity {
  if (!isDev) {
    return {
      name: BASE_APP_NAME,
      appName: BASE_APP_NAME,
      isDev: false,
      devLabel: null,
      devBranch: null,
      devWorktreeName: null,
      devRepoRoot: null,
      dockBadgeLabel: null,
      appUserModelId: BASE_APP_USER_MODEL_ID
    }
  }

  const repoRoot = cleanEnvValue(env.ORCA_DEV_REPO_ROOT)
  const branch = cleanEnvValue(env.ORCA_DEV_BRANCH)
  const worktreeName =
    cleanEnvValue(env.ORCA_DEV_WORKTREE_NAME) ??
    cleanEnvValue(path.basename(repoRoot ?? process.cwd()))
  const devLabel = cleanEnvValue(env.ORCA_DEV_INSTANCE_LABEL) ?? formatLabel(branch, worktreeName)
  const dockTitle =
    cleanEnvValue(env.ORCA_DEV_DOCK_TITLE) ?? `${BASE_APP_NAME}: ${branch ?? devLabel ?? 'dev'}`

  return {
    name: dockTitle,
    // Why: one stable Keychain key ('Orca Dev Safe Storage') for all dev
    // branches; the per-branch identity still shows via `name` (window title,
    // app menu, renderer label).
    appName: `${BASE_APP_NAME} Dev`,
    isDev: true,
    devLabel,
    devBranch: branch,
    devWorktreeName: worktreeName,
    devRepoRoot: repoRoot,
    dockBadgeLabel: null,
    appUserModelId: createDevAppUserModelId(repoRoot ?? devLabel)
  }
}
