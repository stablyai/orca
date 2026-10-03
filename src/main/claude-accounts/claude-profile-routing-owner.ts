import { CLAUDE_ACCOUNT_SIGN_IN_REQUIRED } from '../../shared/claude-account-refusal-copy'
import type { ClaudeProfileDescriptor } from './claude-profile-paths'
import type { ClaudeProfileSetupReport } from './claude-profile-setup'
import type { ClaudeLoginIdentity, ClaudeLoginState } from './claude-profile-readiness'
import type { ClaudeAccountSelectionTarget } from './runtime-selection'

export type ClaudeProfileLaunchDescriptor = {
  profile: ClaudeProfileDescriptor | null
  /** Paths belong to the execution host; readHome may be the host's UNC access path. */
  configHome: string
  readHome: string
  defaultHome: string
  /** System Default's own CLAUDE_CONFIG_DIR, which launches inherit unpatched; absent when unset. */
  inheritedConfigDir?: string
  pointerPath: string
  target: ClaudeAccountSelectionTarget
}

export type ClaudeProfileRoutingOwner = {
  resolve: (target?: ClaudeAccountSelectionTarget) => ClaudeProfileLaunchDescriptor
  /** `managedGuest`: read through the managed runtime even for System Default (sign-in observation). */
  refresh?: (
    target?: ClaudeAccountSelectionTarget,
    access?: ClaudeProfileHostAccess,
    options?: { managedGuest?: boolean }
  ) => Promise<void>
  pointerPath: (target?: ClaudeAccountSelectionTarget) => string
  targets: () => ClaudeAccountSelectionTarget[]
  /** All known owned profiles, including unselected profiles with private/retained history. */
  readHomes: (
    target?: ClaudeAccountSelectionTarget,
    surface?: 'projects' | 'transcripts'
  ) => string[]
  capabilities: (target: ClaudeAccountSelectionTarget) => readonly string[]
  /** Derived from step-1 setup's own output, so no flag records that setup ran. */
  isProvisioned: (descriptor: ClaudeProfileLaunchDescriptor) => boolean
  accountHome?: (accountId: string) => string
  /** The account profile's readiness and the login Claude recorded there, from one read. */
  profileState: (accountId: string) => ClaudeLoginState
  /** The host's own (System Default) login, read where Claude itself reads it. */
  systemDefaultIdentity?: () => ClaudeLoginIdentity | null
  /** Implemented on the owning host/guest; never materializes through a Windows UNC share. */
  prepare: (
    descriptor: ClaudeProfileLaunchDescriptor,
    access?: ClaudeProfileHostAccess
  ) => Promise<ClaudeProfileSetupReport>
  trust?: (
    descriptor: ClaudeProfileLaunchDescriptor,
    workspace: string,
    access?: ClaudeProfileHostAccess
  ) => Promise<void>
  publish: (
    descriptor: ClaudeProfileLaunchDescriptor,
    access?: ClaudeProfileHostAccess
  ) => Promise<void>
  /** Removes the pointer so the shell refuses visibly; never throws. */
  withdraw: (
    target?: ClaudeAccountSelectionTarget,
    access?: ClaudeProfileHostAccess
  ) => void | Promise<void>
  /** Resolves false when the host stays unreachable for a short, bounded wait. */
  reachable?: (target: ClaudeAccountSelectionTarget) => Promise<boolean>
  /** A target that is no longer routed returns to System Default; withdraws when absent. */
  retire?: (target: ClaudeAccountSelectionTarget, access: ClaudeProfileHostAccess) => Promise<void>
}

/** User-initiated work may boot a stopped WSL distro, as a legacy spawn or \\wsl$ write does;
 *  background work (startup, pane repair, readers) only talks to a running one. */
export type ClaudeProfileHostAccess = 'boot' | 'if-running'

/** The account's own profile has no login; every other profile problem is "unavailable". */
export class ClaudeProfileSignInRequiredError extends Error {
  override name = 'ClaudeProfileSignInRequiredError'
  constructor(message = CLAUDE_ACCOUNT_SIGN_IN_REQUIRED) {
    super(message)
  }
}

/** The account's profile holds another login than the one it was added as. */
export class ClaudeProfileIdentityRefusalError extends Error {
  override name = 'ClaudeProfileIdentityRefusalError'
}

/** The execution host could not be reached, so its pointer cannot be stale or rewritten. */
export class ClaudeProfileHostUnreachableError extends Error {
  override name = 'ClaudeProfileHostUnreachableError'
}

/** The execution host itself is gone (wsl.exe: WSL_E_DISTRO_NOT_FOUND), so it has no pointer. */
export class ClaudeProfileHostMissingError extends Error {
  override name = 'ClaudeProfileHostMissingError'
}
