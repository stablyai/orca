import {
  rotationAccountSettings,
  type ClaudeAccountRotationFolder,
  type ClaudeAccountRotationPause,
  type ClaudeAccountRotationSettings,
  type ClaudeAccountRotationStatus
} from '../../../shared/agent-accounts/claude/claude-account-rotation'
import { claudeAccountOf, type RotationCheckDeps } from './claude-rotation-candidates'
import { accessTokenOf, accessUsable, hasRefreshToken, oauthOf } from './claude-rotation-keychain'
import { readOauthAccount, type RotationFolder } from './claude-rotation-login-meta'
import {
  effectiveUsage,
  overReasons,
  sortCandidates,
  type RotationCandidate
} from './claude-rotation-policy'
import type { RotationState } from './claude-rotation-state-files'

export type RotationFolderSnapshot = {
  claudeAccount: string | null
  login: ClaudeAccountRotationFolder['login']
  sessions: number | null
}

/** What each folder holds right now, for the settings status; reads no token outside main. */
export async function snapshotRotationFolders(
  folders: RotationFolder[],
  sessions: Map<string, number> | null,
  state: RotationState,
  deps: RotationCheckDeps
): Promise<Map<string, RotationFolderSnapshot>> {
  const snapshot = new Map<string, RotationFolderSnapshot>()
  for (const folder of folders) {
    const count = sessions ? (sessions.get(folder.home) ?? 0) : null
    try {
      const oauth = oauthOf(await deps.slots.read(folder.service))
      const login =
        !hasRefreshToken(oauth) && !accessTokenOf(oauth)
          ? 'none'
          : accessUsable(oauth, deps.now())
            ? 'active'
            : 'resting'
      snapshot.set(folder.accountId, {
        claudeAccount:
          login === 'none' ? null : (await claudeAccountOf(state, folder, oauth, deps)).account,
        login,
        sessions: count
      })
    } catch {
      snapshot.set(folder.accountId, { claudeAccount: null, login: 'unknown', sessions: count })
    }
  }
  return snapshot
}

async function folderAccountFromFile(folder: RotationFolder): Promise<string | null> {
  const uuid = (await readOauthAccount(folder)).accountUuid
  return typeof uuid === 'string' && uuid ? uuid.slice(0, 8) : null
}

export async function buildRotationStatus(args: {
  rotation: ClaudeAccountRotationSettings
  supported: boolean
  externalRotatorActive: boolean
  pause: ClaudeAccountRotationPause
  folders: RotationFolder[]
  selectedAccountId: string | null
  label: (accountId: string) => string | null
  snapshot: Map<string, RotationFolderSnapshot>
  state: RotationState
  pendingSwitch: boolean
  switchNeedsRepair: boolean
  now: number
}): Promise<ClaudeAccountRotationStatus> {
  const { rotation, state, now } = args
  const folders: ClaudeAccountRotationFolder[] = []
  for (const folder of args.folders) {
    const snap = args.snapshot.get(folder.accountId)
    const claudeAccount = snap?.claudeAccount ?? (await folderAccountFromFile(folder))
    const record = claudeAccount ? state.accounts[claudeAccount] : undefined
    const usage = record ? effectiveUsage(record, now) : null
    folders.push({
      accountId: folder.accountId,
      claudeAccount,
      label: args.label(folder.accountId),
      selected: folder.accountId === args.selectedAccountId,
      sessions: snap?.sessions ?? null,
      login: snap?.login ?? 'unknown',
      usage:
        usage && record
          ? {
              fiveHourPercent: Math.round(usage.five),
              weeklyPercent: Math.round(usage.week),
              weeklyResetsAt: usage.weekResetsAt,
              checkedAt: record.checkedAt
            }
          : null
    })
  }
  const selected = folders.find((folder) => folder.selected)
  const candidates: RotationCandidate[] = []
  for (const folder of folders) {
    const record = folder.claudeAccount ? state.accounts[folder.claudeAccount] : undefined
    if (
      folder.selected ||
      folder.sessions !== 0 ||
      (folder.login !== 'active' && folder.login !== 'resting') ||
      !folder.claudeAccount ||
      folder.claudeAccount === selected?.claudeAccount
    ) {
      continue
    }
    const own = rotationAccountSettings(rotation, folder.claudeAccount)
    const usage = record ? effectiveUsage(record, now) : null
    if (!own.enabled || (usage && overReasons(usage, own).length > 0)) {
      continue
    }
    candidates.push({
      accountId: folder.accountId,
      claudeAccount: folder.claudeAccount,
      known: usage !== null,
      live: false,
      usage
    })
  }
  return {
    supported: args.supported,
    enabled: rotation.enabled,
    pause: args.pause,
    externalRotatorActive: args.externalRotatorActive,
    settings: rotation,
    folders,
    lastSwitch: state.lastSwitch ?? null,
    nextCandidateAccountId: sortCandidates(candidates, rotation, now)[0]?.accountId ?? null,
    lastNote: args.selectedAccountId ? (state.folders[args.selectedAccountId]?.note ?? null) : null,
    lastCheckedAt: state.lastCheckedAt ?? null,
    pendingSwitch: args.pendingSwitch,
    switchNeedsRepair: args.switchNeedsRepair
  }
}
