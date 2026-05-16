import { createHash } from 'crypto'
import path from 'path'
import type { AppIdentity } from '../../shared/app-identity'

const BASE_APP_NAME = 'Orca'
const BASE_APP_USER_MODEL_ID = 'com.stablyai.orca'
const MAX_LABEL_LENGTH = 80

export type DevInstanceIdentity = AppIdentity & {
  appUserModelId: string
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
  return normalized.split('/').filter(Boolean).at(-1) ?? value
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

function createBadgeSuffix(seed: string): string {
  const n = parseInt(createHash('sha1').update(seed).digest('hex').slice(0, 8), 16)
  return (n % 1296).toString(36).toUpperCase().padStart(2, '0')
}

export function createDevDockBadgeLabel(
  value: string | null,
  identitySeed?: string | null
): string | null {
  if (!value) {
    return null
  }

  const source = lastPathSegment(value)
  const words = source.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  const label =
    words.length > 1
      ? words
          .slice(0, 2)
          .map((word) => word[0])
          .join('')
      : (words[0] ?? source).slice(0, 2)
  const prefix = (label.replace(/[^a-zA-Z0-9]/g, '').toUpperCase() || 'D').slice(0, 2)
  return `${prefix}${createBadgeSuffix(identitySeed ?? value)}`
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
  const identitySeed = cleanEnvValue(env.ORCA_DEV_INSTANCE_KEY) ?? repoRoot ?? devLabel
  const dockBadgeLabel =
    cleanEnvValue(env.ORCA_DEV_DOCK_BADGE_LABEL) ??
    createDevDockBadgeLabel(worktreeName ?? branch ?? devLabel, identitySeed)
  const dockTitle =
    cleanEnvValue(env.ORCA_DEV_DOCK_TITLE) ??
    `${BASE_APP_NAME} Dev${dockBadgeLabel ? ` [${dockBadgeLabel}]` : ''}: ${branch ?? devLabel ?? 'dev'}`

  return {
    name: dockTitle,
    isDev: true,
    devLabel,
    devBranch: branch,
    devWorktreeName: worktreeName,
    devRepoRoot: repoRoot,
    dockBadgeLabel,
    appUserModelId: createDevAppUserModelId(repoRoot ?? devLabel)
  }
}
