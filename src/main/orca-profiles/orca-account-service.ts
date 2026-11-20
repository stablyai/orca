import type {
  ConnectCurrentOrcaProfileResult,
  CreateCloudLinkedOrcaProfileArgs,
  CreateCloudLinkedOrcaProfileResult,
  OrcaProfileAuthStatus,
  RefreshCurrentOrcaProfileAuthResult,
  SelectOrcaProfileOrgResult,
  SignOutCurrentOrcaProfileResult
} from '../../shared/orca-profiles/orca-profiles'
import { getProfileUserDataPath } from './profile-storage-paths'
import {
  connectCurrentOrcaProfile,
  createCloudLinkedOrcaProfile,
  getCurrentOrcaProfileAuthStatus,
  selectCurrentOrcaProfileOrg,
  signOutCurrentOrcaProfile
} from './cloud-auth/profile-cloud-service'
import { refreshCurrentOrcaProfileAuth } from './cloud-auth/profile-cloud-capability-refresh'
import type { OrcaCloudAuthConfig } from './cloud-auth/profile-cloud-auth-config'
import { signInCurrentOrcaProfileWithCode } from './cloud-auth/profile-cloud-code-sign-in'
import type { OrcaCloudAuthorizationCode } from './cloud-auth/profile-cloud-pkce'
import type {
  CloudAccountTransition,
  CloudSessionCommitGuards
} from './cloud-session/profile-cloud-session-commit'

/** Side effects every account change must run, whichever caller (window or runtime RPC) made it. */
export type OrcaAccountLifecycleHooks = {
  /** After a sign-in, org change or capability refresh succeeds. */
  onAuthMutation?: () => void
  /** Before sign-out touches the network, so nothing keeps running as the old account. */
  onBeforeSignOut?: () => void
  onAfterSignOut?: () => void
}

export type OrcaAccountServicePorts = {
  /** Hosts without a browser (orcad) never start the loopback flow, so they pass a refusing opener. */
  openBrowser: (url: string) => Promise<void>
  userDataPath?: () => string
  hooks?: OrcaAccountLifecycleHooks
  /** Links other features made under an account; while they exist, only that account may be
   * signed in (D5). */
  accountBoundLinks?: AccountBoundLinks
}

export type AccountBoundLinks = {
  /** The profile whose links these are; an account change for any other profile is refused. */
  profileId: () => string | null
  /** Why `nextUserId` may not become the account, or null. A link with no recorded owner belongs
   * to `profileUserId`, the profile's current account. */
  refusal: (nextUserId: string, profileUserId: string | null) => string | null
  /** The accounts the links belong to and the bots that hold them, for a page that warns before a move. */
  holders?: (profileUserId: string | null) => { ownerUserIds: string[]; botNames: string[] }
}

/** One Orca account per host; Electron-free so desktop and orcad share it. */
export class OrcaAccountService {
  private readonly openBrowser: (url: string) => Promise<void>
  private readonly userDataPath: () => string
  private readonly hooks: OrcaAccountLifecycleHooks
  private readonly accountBoundLinks: AccountBoundLinks | undefined
  private switchingCloudServer = false
  private readonly signOutListeners = new Set<() => void>()

  constructor(ports: OrcaAccountServicePorts) {
    this.openBrowser = ports.openBrowser
    this.userDataPath = ports.userDataPath ?? getProfileUserDataPath
    this.hooks = ports.hooks ?? {}
    this.accountBoundLinks = ports.accountBoundLinks
  }

  /** Checked against the exchanged identity right before an account is committed. */
  private readonly mayCommit = (transition: CloudAccountTransition): string | null => {
    const links = this.accountBoundLinks
    if (!links) {
      return null
    }
    if (links.profileId() !== transition.profileId) {
      return 'The Orca profile changed during sign-in. Try again.'
    }
    return links.refusal(transition.nextUserId, transition.currentUserId)
  }

  getAuthStatus(): OrcaProfileAuthStatus {
    return getCurrentOrcaProfileAuthStatus(this.userDataPath())
  }

  /** What a sign-in's approval page shows before it moves this host to another account: the
   *  account it was on, and who its bots' links belong to. */
  signInContext(): {
    previous: { userId: string; email: string } | null
    links: { ownerUserIds: string[]; botNames: string[] } | null
  } {
    const cloud = this.getAuthStatus().cloud
    const previous = cloud ? { userId: cloud.userId, email: cloud.email } : null
    const links = this.accountBoundLinks?.holders?.(previous?.userId ?? null) ?? null
    return { previous, links: links && links.ownerUserIds.length > 0 ? links : null }
  }

  async connect(): Promise<ConnectCurrentOrcaProfileResult> {
    this.assertCloudServerStable()
    const result = await connectCurrentOrcaProfile(
      this.userDataPath(),
      this.openBrowser,
      this.mayCommit
    )
    if (result.status === 'connected') {
      this.hooks.onAuthMutation?.()
    }
    return result
  }

  /** Finishes a sign-in whose browser leg ran on another device. */
  async signInWithCode(
    config: OrcaCloudAuthConfig,
    code: OrcaCloudAuthorizationCode,
    guards: Pick<
      CloudSessionCommitGuards,
      'signal' | 'requireSealedStorage' | 'expectedLinkEpoch'
    > = {}
  ): Promise<ConnectCurrentOrcaProfileResult> {
    this.assertCloudServerStable()
    const result = await signInCurrentOrcaProfileWithCode(this.userDataPath(), config, code, {
      ...guards,
      mayCommit: this.mayCommit
    })
    if (result.status === 'connected') {
      this.hooks.onAuthMutation?.()
    }
    return result
  }

  /** `onCreated` runs before the account hooks, for per-profile setup the caller owns. */
  async createCloudLinked(
    args: CreateCloudLinkedOrcaProfileArgs,
    onCreated?: (profileId: string) => void
  ): Promise<CreateCloudLinkedOrcaProfileResult> {
    this.assertCloudServerStable()
    const result = await createCloudLinkedOrcaProfile(this.userDataPath(), args)
    if (result.status === 'created') {
      onCreated?.(result.profile.id)
      this.hooks.onAuthMutation?.()
    }
    return result
  }

  async refreshAuth(): Promise<RefreshCurrentOrcaProfileAuthResult> {
    this.assertCloudServerStable()
    const result = await refreshCurrentOrcaProfileAuth(this.userDataPath())
    if (result.status === 'refreshed') {
      this.hooks.onAuthMutation?.()
    }
    return result
  }

  async selectOrg(orgId: string): Promise<SelectOrcaProfileOrgResult> {
    this.assertCloudServerStable()
    const result = await selectCurrentOrcaProfileOrg(this.userDataPath(), orgId)
    if (result.status === 'selected') {
      this.hooks.onAuthMutation?.()
    }
    return result
  }

  async withCloudServerSwitch<T>(operation: () => Promise<T>): Promise<T> {
    this.assertCloudServerStable()
    this.switchingCloudServer = true
    try {
      return await operation()
    } finally {
      this.switchingCloudServer = false
    }
  }

  private assertCloudServerStable(): void {
    if (this.switchingCloudServer) {
      throw new Error('cloud_server_switch_in_progress')
    }
  }

  /** Every sign-out, whichever caller (window or runtime RPC) made it. */
  onSignOutStarted(listener: () => void): () => void {
    this.signOutListeners.add(listener)
    return () => {
      this.signOutListeners.delete(listener)
    }
  }

  async signOut(): Promise<SignOutCurrentOrcaProfileResult> {
    for (const listener of this.signOutListeners) {
      listener()
    }
    this.hooks.onBeforeSignOut?.()
    return signOutCurrentOrcaProfile(this.userDataPath()).finally(this.hooks.onAfterSignOut)
  }
}
