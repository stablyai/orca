import type { ClaudeAccountRotationSettings } from '../../../shared/agent-accounts/claude/claude-account-rotation'
import {
  claudeAccountOf,
  recordUsage,
  rotationCandidates,
  type RotationCheckDeps,
  type RotationSkip
} from './claude-rotation-candidates'
import {
  accessTokenOf,
  accessUsable,
  oauthOf,
  type ClaudeKeychainSlot
} from './claude-rotation-keychain'
import type { RotationFolder } from './claude-rotation-login-meta'
import {
  describeOverReasons,
  overReasons,
  returnRule,
  ROTATION_TIMING,
  type RotationCandidate,
  type RotationOverReason,
  type RotationUsage
} from './claude-rotation-policy'
import type {
  RotationJournal,
  RotationState,
  RotationSwapKind
} from './claude-rotation-state-files'
import { swapFolderLogins } from './claude-rotation-swap'

export type RotationCheckResult =
  | { note: string }
  | {
      note: 'swapped'
      journal: RotationJournal
      kind: RotationSwapKind
      over: RotationOverReason[]
      usage: RotationUsage
    }
  | {
      note: 'over_no_candidate'
      over: RotationOverReason[]
      alert: boolean
      skipped: RotationSkip[]
    }

/** One check of one folder, ported from claude_rotate.py `auto`. Null when not due yet. */
export async function checkRotationFolder(args: {
  target: RotationFolder
  folders: RotationFolder[]
  sessions: Map<string, number> | null
  state: RotationState
  settings: ClaudeAccountRotationSettings
  deps: RotationCheckDeps
}): Promise<RotationCheckResult | null> {
  const { target, state, settings, deps } = args
  const now = deps.now()
  const folderState = (state.folders[target.accountId] ??= {})
  if (now < (folderState.nextCheckAt ?? 0)) {
    return null
  }
  folderState.nextCheckAt = now + ROTATION_TIMING.checkGapMs
  const done = (result: RotationCheckResult): RotationCheckResult => {
    folderState.note = result.note
    return result
  }

  let targetSlot: ClaudeKeychainSlot | null
  try {
    targetSlot = await deps.slots.read(target.service)
  } catch {
    return done({ note: 'keychain_unreadable' })
  }
  const oauth = oauthOf(targetSlot)
  const token = accessTokenOf(oauth)
  if (!token) {
    return done({ note: 'no_login' })
  }
  if (!accessUsable(oauth, now)) {
    return done({ note: 'access_expired' })
  }
  const read = await deps.fetchUsage(token)
  if (read.status !== 'ok') {
    if (read.status === 'rate-limited') {
      folderState.nextCheckAt = now + ROTATION_TIMING.rateLimitedBackoffMs
    }
    return done({ note: read.status === 'rate-limited' ? 'usage_rate_limited' : 'usage_failed' })
  }
  const usage = read.usage
  const account = await claudeAccountOf(state, target, oauth, deps)
  recordUsage(state, account, usage, now)
  const over = overReasons(usage, settings)
  const sinceSwap = now - (state.lastSwapAt ?? 0)
  const shared = {
    folders: args.folders,
    target,
    targetSlot,
    targetAccount: account,
    sessions: args.sessions,
    state,
    settings,
    deps
  }

  let kind: RotationSwapKind = 'over'
  let reason: string
  let picked: RotationCandidate | null
  if (over.length === 0) {
    const rule = returnRule(settings, { claudeAccount: account, usage }, now)
    const due = sinceSwap >= ROTATION_TIMING.minSwapGapMs && now >= (folderState.nextPreferAt ?? 0)
    if (!rule || !due) {
      return done({ note: 'ok' })
    }
    folderState.nextPreferAt = now + ROTATION_TIMING.preferCheckGapMs
    const { candidates } = await rotationCandidates({ ...shared, only: rule.wants })
    picked = rule.choose(candidates)
    if (!picked) {
      return done({ note: 'ok' })
    }
    kind = settings.order === 'reset' ? 'reset' : 'prefer'
    reason =
      kind === 'reset'
        ? 'an account whose weekly limit resets sooner has room'
        : 'a preferred account has room'
  } else {
    reason = describeOverReasons(over)
    // A deliberate return, or a pick from stored readings, may land on a spent account: move on at once.
    if (
      sinceSwap < ROTATION_TIMING.minSwapGapMs &&
      state.lastSwapKind !== 'prefer' &&
      state.lastSwapKind !== 'reset' &&
      state.lastSwapLive !== false
    ) {
      return done({ note: 'over_wait_gap' })
    }
    const { candidates, skipped } = await rotationCandidates(shared)
    picked = candidates[0] ?? null
    if (!picked) {
      const alert = now - (state.lastAlertAt ?? 0) > ROTATION_TIMING.alertGapMs
      if (alert) {
        state.lastAlertAt = now
        deps.files.log('no_candidate', { folder: target.accountId, account, reason, skipped })
      }
      return done({ note: 'over_no_candidate', over, alert, skipped })
    }
  }

  const chosen = picked
  const source = args.folders.find((folder) => folder.accountId === chosen.accountId)
  // Usage reads take seconds; a session may have started in the chosen folder meanwhile.
  const fresh = await deps.readSessions()
  if (!source || fresh === null || (fresh.get(source.home) ?? 0) > 0) {
    return done({ note: 'candidate_busy' })
  }
  const result = await swapFolderLogins(
    target,
    source,
    { reason, kind, fromAccount: account, toAccount: chosen.claudeAccount },
    deps
  )
  if (!result.ok) {
    deps.files.log('swap_skipped', { folder: target.accountId, detail: result.detail })
    return done({ note: 'swap_failed' })
  }
  state.lastSwapAt = deps.now()
  state.lastSwapKind = kind
  state.lastSwapLive = chosen.live
  // The next cycle checks the folder again on its new account.
  state.folders[target.accountId] = { note: 'swapped' }
  deps.files.log('swap', {
    folder: target.accountId,
    withFolder: source.accountId,
    fromAccount: account,
    toAccount: chosen.claudeAccount,
    reason,
    meta: result.journal.meta
  })
  return { note: 'swapped', journal: result.journal, kind, over, usage }
}
