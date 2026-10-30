import type {
  LiveAlertShowResult,
  LiveAlertsCapabilities
} from '../../modules/orca-live-alerts/src'

/** What the live notification says about one agent. */
export type LivePhase = 'working' | 'waiting' | 'done' | 'failed' | 'stopped'

/** Why a waiting agent waits: a permission prompt (a tool is named) or a question. */
export type LiveNeed = 'approval' | 'input'

/** One agent row from a host's worktree.ps reply, reduced to what the notification needs. */
export type LiveAgent = {
  /** Unique across hosts: the paired host plus the pane. */
  key: string
  hostId: string
  hostName: string
  worktreeId: string
  /** The worktree's display name, else its branch. */
  workspace: string
  /** The `runtime:` server the workspace runs on; null for the desktop's own workspaces. */
  executionHost: string | null
  paneKey: string
  phase: LivePhase
  need: LiveNeed | null
  agentType: string | null
  prompt: string
  lastAssistantMessage: string | null
  toolName: string | null
  toolInput: string | null
  stateStartedAt: number
  updatedAt: number
}

/** The phases the native renderer knows (LiveAlertPayload.kt). */
export type LiveNotificationPhase = 'working' | 'waiting' | 'lingering' | 'final'

/** What the native module renders; field names match LiveAlertPayload.kt. */
export type LiveAlertPayload = {
  phase: LiveNotificationPhase
  title: string
  text: string
  subText: string | null
  /** Status-bar chip text on Android 16+, 7 characters or fewer. */
  chipText: string | null
  startedAt: number
  progressFinished: number | null
  progressTotal: number | null
  indeterminate: boolean
  targetJson: string | null
}

/** Where a tap goes: the fields getNotificationNavigationTarget reads. */
export type LiveAlertTarget = {
  hostId: string
  worktreeId: string
  paneKey: string
  executionHost?: string
}

/** The Android bridge to modules/orca-live-alerts; live-alerts-native.ts is null elsewhere. */
export type LiveAlertsNativeAdapter = {
  capabilities(): LiveAlertsCapabilities | null
  show(payload: LiveAlertPayload): Promise<LiveAlertShowResult>
  finish(payload: LiveAlertPayload | null): Promise<void>
  cancel(): Promise<void>
  subscribeTick(listener: () => void): () => void
  subscribeDismissed(listener: () => void): () => void
  /** Delivers the target the app was launched with first, then later taps. */
  subscribeTaps(listener: (target: unknown) => void): () => void
  openPromotionSettings(): void
  openAppNotificationSettings(): void
  openAppDetailsSettings(): void
}

export type { LiveAlertShowResult, LiveAlertsCapabilities }
