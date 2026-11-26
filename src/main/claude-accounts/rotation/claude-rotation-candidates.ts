import type { ClaudeAccountRotationSettings } from '../../../shared/agent-accounts/claude/claude-account-rotation'
import type { RotationUsageFetch } from './claude-rotation-api'
import {
  accessTokenOf,
  accessUsable,
  hasRefreshToken,
  oauthOf,
  refreshExpired,
  tokenHash,
  withOauth,
  type ClaudeAiOauth,
  type ClaudeKeychainSlot
} from './claude-rotation-keychain'
import { readOauthAccount, type RotationFolder } from './claude-rotation-login-meta'
import {
  effectiveUsage,
  overReasons,
  ROTATION_TIMING,
  sortCandidates,
  type RotationCandidate,
  type RotationUsage,
  type RotationUsageRecord
} from './claude-rotation-policy'
import type { RotationState } from './claude-rotation-state-files'
import type { RotationSwapDeps } from './claude-rotation-swap'

export type RotationCheckDeps = RotationSwapDeps & {
  fetchUsage: (accessToken: string) => Promise<RotationUsageFetch>
  /** Claude sessions per folder home; null when they cannot be counted. */
  readSessions: () => Promise<Map<string, number> | null>
}

export type RotationSkip = { accountId: string; reason: string }

function accountPrefix(value: unknown): string | null {
  return typeof value === 'string' && value ? value.slice(0, 8) : null
}

/** The account a folder holds: the server's answer for a live token, else what the folder says. */
export async function claudeAccountOf(
  state: RotationState,
  folder: RotationFolder,
  oauth: ClaudeAiOauth,
  deps: RotationCheckDeps
): Promise<string | null> {
  const guess =
    accountPrefix(oauth.accountUuid) ?? accountPrefix((await readOauthAccount(folder)).accountUuid)
  const token = accessTokenOf(oauth)
  const now = deps.now()
  if (!token || !accessUsable(oauth, now)) {
    return guess
  }
  const key = tokenHash(token)
  const hit = state.tokens[key]
  if (hit?.account) {
    return hit.account
  }
  const who = await deps.whoami(token)
  if (!who) {
    return guess
  }
  for (const [cached, entry] of Object.entries(state.tokens)) {
    if (now - (entry?.at ?? 0) > ROTATION_TIMING.tokenAccountCacheMs) {
      delete state.tokens[cached]
    }
  }
  state.tokens[key] = { account: who, at: now }
  if (guess && guess !== who) {
    deps.files.log('account_mismatch', { folder: folder.accountId, written: guess, actual: who })
  }
  return who
}

export function recordUsage(
  state: RotationState,
  account: string | null,
  usage: RotationUsage,
  now: number
): void {
  if (account) {
    state.accounts[account] = { ...usage, checkedAt: now }
  }
}

/** Folders whose login could move into `target`, best first, with why the others were left out. */
export async function rotationCandidates(args: {
  folders: RotationFolder[]
  target: RotationFolder
  targetSlot: ClaudeKeychainSlot | null
  targetAccount: string | null
  sessions: Map<string, number> | null
  state: RotationState
  settings: ClaudeAccountRotationSettings
  deps: RotationCheckDeps
  only?: (account: string, stored: RotationUsageRecord | undefined) => boolean
}): Promise<{ candidates: RotationCandidate[]; skipped: RotationSkip[] }> {
  const { target, sessions, state, settings, deps } = args
  const candidates: RotationCandidate[] = []
  const skipped: RotationSkip[] = []
  for (const folder of args.folders) {
    if (folder.accountId === target.accountId) {
      continue
    }
    const skip = (reason: string): void => {
      skipped.push({ accountId: folder.accountId, reason })
    }
    if (sessions === null) {
      skip('sessions_unknown')
      continue
    }
    if ((sessions.get(folder.home) ?? 0) > 0) {
      skip('sessions_running')
      continue
    }
    let slot: ClaudeKeychainSlot | null
    try {
      slot = await deps.slots.read(folder.service)
    } catch {
      skip('keychain_unreadable')
      continue
    }
    const oauth = oauthOf(slot)
    if (!hasRefreshToken(oauth)) {
      skip('no_login')
      continue
    }
    const now = deps.now()
    if (refreshExpired(oauth, now)) {
      skip('login_expired')
      continue
    }
    const account = await claudeAccountOf(state, folder, oauth, deps)
    if (!account) {
      skip('account_unknown')
      continue
    }
    if (account === args.targetAccount) {
      skip('same_account')
      continue
    }
    if (args.only && !args.only(account, state.accounts[account])) {
      continue
    }
    const fits =
      deps.slots.fits(target.service, withOauth(args.targetSlot, oauth)) &&
      deps.slots.fits(folder.service, withOauth(slot, oauthOf(args.targetSlot)))
    if (!fits) {
      skip('slot_too_large')
      continue
    }
    let usage: RotationUsage | null = null
    let live = false
    const token = accessTokenOf(oauth)
    if (token && accessUsable(oauth, now)) {
      const read = await deps.fetchUsage(token)
      if (read.status === 'ok') {
        usage = read.usage
        live = true
        recordUsage(state, account, usage, deps.now())
      }
    }
    const stored = state.accounts[account]
    if (!usage && stored) {
      usage = effectiveUsage(stored, now)
    }
    if (usage && overReasons(usage, settings).length > 0) {
      skip('also_near_limit')
      continue
    }
    candidates.push({
      accountId: folder.accountId,
      claudeAccount: account,
      known: usage !== null,
      live,
      usage
    })
  }
  return { candidates: sortCandidates(candidates, settings, deps.now()), skipped }
}
