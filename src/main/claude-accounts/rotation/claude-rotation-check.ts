import {
  rotationAccountSettings,
  type ClaudeAccountRotationSettings
} from '../../../shared/agent-accounts/claude/claude-account-rotation'
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
  tokenHash,
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
  /**
   * Read again right before the first write, since the setting or either account may be turned
   * off mid-check. Null when rotation is off or another tool took over.
   */
  currentSettings?: () => Promise<ClaudeAccountRotationSettings | null>
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
  const { account, confirmed } = await claudeAccountOf(state, target, oauth, deps)
  if (!confirmed) {
    // The reading would be filed under the folder's own claim, which may be stale; try again later.
    return done({ note: 'account_unconfirmed' })
  }
  recordUsage(state, account, usage, now)
  const own = rotationAccountSettings(settings, account)
  if (!own.enabled) {
    // Taken out of rotation: Orca neither moves it out nor brings another account in.
    return done({ note: 'account_off' })
  }
  const over = overReasons(usage, own)
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
  let refreshOf: Map<string, string>
  if (over.length === 0) {
    const rule = returnRule(settings, { claudeAccount: account, usage }, now)
    const due = sinceSwap >= ROTATION_TIMING.minSwapGapMs && now >= (folderState.nextPreferAt ?? 0)
    if (!rule || !due) {
      return done({ note: 'ok' })
    }
    folderState.nextPreferAt = now + ROTATION_TIMING.preferCheckGapMs
    const found = await rotationCandidates({ ...shared, only: rule.wants })
    refreshOf = found.refreshOf
    picked = rule.choose(found.candidates)
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
    const found = await rotationCandidates(shared)
    const skipped = found.skipped
    refreshOf = found.refreshOf
    picked = found.candidates[0] ?? null
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
  const sourceRefresh = refreshOf.get(chosen.accountId)
  if (!source || sourceRefresh === undefined) {
    return done({ note: 'swap_failed' })
  }
  const result = await swapFolderLogins(
    target,
    source,
    { reason, kind, fromAccount: account, toAccount: chosen.claudeAccount },
    deps,
    {
      aRefresh: tokenHash(oauth.refreshToken),
      bRefresh: sourceRefresh,
      beforeWrite: async () => {
        // Usage reads take seconds; a session may have started in the chosen folder meanwhile.
        const fresh = await deps.readSessions()
        if (fresh === null || (fresh.get(source.home) ?? 0) > 0) {
          return 'candidate_busy'
        }
        // Last, so a change during the session read still stops the swap. The external tool takes
        // the same refresh locks before it writes, so it cannot write these slots while they are held.
        if (!args.currentSettings) {
          return null
        }
        const current = await args.currentSettings()
        if (current === null) {
          return 'turned_off'
        }
        const off = [account, chosen.claudeAccount].some(
          (id) => !rotationAccountSettings(current, id).enabled
        )
        return off ? 'account_off' : null
      }
    }
  )
  if (!result.ok) {
    deps.files.log('swap_skipped', { folder: target.accountId, detail: result.detail })
    return done({ note: result.detail === 'candidate_busy' ? 'candidate_busy' : 'swap_failed' })
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
