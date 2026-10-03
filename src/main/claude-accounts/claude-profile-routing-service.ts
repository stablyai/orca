import { CLAUDE_PROFILE_POINTER_ENV } from '../../shared/claude-profile-routing'
import type { ClaudeRateLimitAccountsState } from '../../shared/managed-account-types'
import {
  claudeProfilePointerKeepsSystemDefault,
  describeClaudeProfilePublishError,
  readClaudeProfilePointer
} from './claude-profile-pointer'
import { ClaudeProfilePointerQueue } from './claude-profile-pointer-queue'
import {
  ClaudeProfileHostUnreachableError,
  ClaudeProfileSignInRequiredError,
  type ClaudeProfileHostAccess,
  type ClaudeProfileLaunchDescriptor,
  type ClaudeProfileRoutingOwner
} from './claude-profile-routing-owner'
import type { ClaudeAccountSelectionTarget } from './runtime-selection'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth-service'
import type { ClaudeEnvPatch } from './environment'
import {
  describeClaudeSystemDefaultFor,
  findClaudeAccountIdentityRefusal,
  withObservedClaudeIdentities,
  type ClaudeObservedAccount
} from './claude-account-identity'
import {
  assertClaudeProfileLaunchable,
  claudeProfileLaunchEnvPatch,
  claudeProfileLaunchPreparation,
  provisionClaudeLaunchProfile
} from './claude-profile-launch-preparation'
import type { ClaudeLoginIdentity } from './claude-profile-readiness'

/** Settings remain authoritative; nothing in this class persists a second selection. */
export class ClaudeProfileRoutingService {
  private readonly publishIssues = new Map<string, string>()
  private readonly pointers = new ClaudeProfilePointerQueue<ClaudeProfileLaunchDescriptor>()
  /** Targets whose newest publish succeeded; re-derived by every publish, never persisted. */
  private readonly current = new Set<string>()
  private readonly backgroundPublishes = new Map<string, Promise<unknown>>()
  private repair: Promise<unknown> | null = null
  constructor(
    private readonly owner: ClaudeProfileRoutingOwner,
    private readonly accounts: () => readonly Omit<ClaudeObservedAccount, 'observed'>[] = () => []
  ) {}
  /** Settings only: a WSL distro is routed while it holds an Orca Claude account. An unrouted one
   *  stays System Default exactly as before profiles: no pointer, no guest call. */
  routes(target?: ClaudeAccountSelectionTarget): boolean {
    if (target?.runtime !== 'wsl') {
      return true
    }
    const distro = target.wslDistro?.trim().toLowerCase()
    return this.owner
      .targets()
      .some((entry) => entry.runtime === 'wsl' && entry.wslDistro?.toLowerCase() === distro)
  }
  resolve(target?: ClaudeAccountSelectionTarget): ClaudeProfileLaunchDescriptor {
    return assertClaudeProfileLaunchable(this.owner.resolve(target), {
      capabilities: (descriptor) => this.owner.capabilities(descriptor.target),
      identityRefusal: (accountId) =>
        findClaudeAccountIdentityRefusal(this.accounts(), accountId, this.owner)
    })
  }
  /** Select and startup set the profile up (`always`); a launch only sets up one that never was. */
  publish(
    target?: ClaudeAccountSelectionTarget,
    provisioning: 'always' | 'if-missing' = 'always',
    access: ClaudeProfileHostAccess = 'if-running'
  ): Promise<ClaudeProfileLaunchDescriptor> {
    const key = publishKey(target)
    return this.pointers.start(key, (generation) =>
      this.publishGeneration(key, generation, target, provisioning, access)
    )
  }
  private async publishGeneration(
    key: string,
    generation: number,
    target: ClaudeAccountSelectionTarget | undefined,
    provisioning: 'always' | 'if-missing',
    access: ClaudeProfileHostAccess
  ): Promise<ClaudeProfileLaunchDescriptor> {
    let descriptor: ClaudeProfileLaunchDescriptor | undefined
    try {
      if (this.owner.refresh) {
        await this.owner.refresh(target, access)
      }
      descriptor = this.resolve(target)
      if (
        descriptor.profile &&
        (provisioning === 'always' || !this.owner.isProvisioned(descriptor))
      ) {
        await provisionClaudeLaunchProfile(this.owner, descriptor, access)
      }
      if (this.resolve(target).configHome !== descriptor.configHome) {
        throw new Error('Claude account changed while preparing its profile; retry')
      }
      const captured = descriptor
      const published = await this.pointers.write(key, generation, () =>
        this.owner.publish(captured, access)
      )
      if (!published) {
        // Why: a newer publish owns the pointer; it speaks for this caller while it names the same profile.
        const newer = await this.pointers.newest(key)
        if (newer?.configHome !== captured.configHome) {
          throw new Error('Claude account changed while preparing its profile; retry')
        }
        return captured
      }
      if (this.pointers.isNewest(key, generation)) {
        this.publishIssues.delete(key)
        this.current.add(key)
      }
      return descriptor
    } catch (error) {
      // Why: an unreachable host's pointer is neither stale nor writable, and a withdraw racing
      // the host coming up could delete a valid one.
      if (error instanceof ClaudeProfileHostUnreachableError) {
        throw error
      }
      // Why: a pointer left naming the previous account would launch it silently. Only the newest
      // target publish, still naming the current selection, speaks for the pointer.
      if (this.pointers.isNewest(key, generation) && !this.isOvertaken(descriptor)) {
        const message = describeClaudeProfilePublishError(error)
        this.current.delete(key)
        this.publishIssues.set(
          key,
          target?.runtime === 'wsl' ? `WSL ${target.wslDistro ?? 'distro'}: ${message}` : message
        )
        try {
          // Why: a pointer already on System Default launches what was asked; removing it refuses.
          if (!claudeProfilePointerKeepsSystemDefault(descriptor)) {
            await this.pointers.write(key, generation, async () => {
              await this.owner.withdraw(target, access)
            })
          }
        } catch (withdrawError) {
          console.warn('[claude-profile] Pointer withdrawal failed:', withdrawError)
        }
      }
      throw error
    }
  }
  /** A distro that lost its last account: panes opened while it was routed fall back to System
   *  Default, as new panes there do. Bookkeeping, so it only warns. */
  async retire(
    target: ClaudeAccountSelectionTarget,
    access: ClaudeProfileHostAccess
  ): Promise<void> {
    const key = publishKey(target)
    // Why: an in-flight publish this overtakes must not wait on itself as the newest one.
    const retired = Promise.reject(
      new Error('Claude account changed while preparing its profile; retry')
    )
    retired.catch(() => {})
    const generation = this.pointers.supersede(key, retired)
    this.current.delete(key)
    this.publishIssues.delete(key)
    try {
      await this.pointers.write(key, generation, async () => {
        await (this.owner.retire?.(target, access) ?? this.owner.withdraw(target, access))
      })
    } catch (error) {
      console.warn('[claude-profile] Pointer withdrawal failed:', error)
    }
  }
  private isOvertaken(descriptor: ClaudeProfileLaunchDescriptor | undefined): boolean {
    try {
      return (
        descriptor !== undefined &&
        this.resolve(descriptor.target).configHome !== descriptor.configHome
      )
    } catch {
      return false
    }
  }
  /** Part of a Claude launch, so it may boot the distro the launch just prepared. */
  trust(descriptor: ClaudeProfileLaunchDescriptor, workspace: string): Promise<void> {
    return this.owner.trust?.(descriptor, workspace, 'boot') ?? Promise.resolve()
  }
  pointerPath(target?: ClaudeAccountSelectionTarget): string {
    return this.owner.pointerPath(target)
  }
  async startup(): Promise<void> {
    let firstError: unknown
    for (const target of this.owner.targets()) {
      const key = publishKey(target)
      try {
        // Why: a launch or select already publishing this target speaks for it, and may be
        // booting a distro this background pass would find stopped and overtake.
        await (this.pointers.busy(key)
          ? this.pointers.newest(key)?.catch(() => {})
          : this.publish(target))
      } catch (error) {
        firstError ??= error
      }
    }
    if (firstError) {
      throw firstError
    }
  }
  /** A Claude launch: user-initiated, so it boots a stopped distro rather than refusing. */
  async prepare(target?: ClaudeAccountSelectionTarget): Promise<ClaudeRuntimeAuthPreparation> {
    return this.preparation(await this.publish(target, 'if-missing', 'boot'))
  }
  preparation(descriptor: ClaudeProfileLaunchDescriptor): ClaudeRuntimeAuthPreparation {
    return claudeProfileLaunchPreparation(descriptor)
  }
  /**
   * A pane's spawn env: its children keep this account until the pane reopens, while the claude
   * function re-reads the pointer. Never waits on a guest and never throws, so a non-Claude pane
   * always opens.
   */
  terminalEnv(target?: ClaudeAccountSelectionTarget): ClaudeEnvPatch {
    if (!this.routes(target)) {
      return {}
    }
    if (target?.runtime === 'wsl') {
      this.publishInBackground(target)
    }
    try {
      return claudeProfileLaunchEnvPatch(this.resolve(target))
    } catch {
      return { [CLAUDE_PROFILE_POINTER_ENV]: this.pointerPath(target) }
    }
  }
  // Why: a distro stopped at startup has no current publish; its first pane re-derives it.
  private publishInBackground(target: ClaudeAccountSelectionTarget): void {
    const key = publishKey(target)
    if (this.current.has(key) || this.backgroundPublishes.has(key)) {
      return
    }
    const repair = async () => {
      // Why wait: the pane's own spawn boots a stopped distro; probing first would only refuse.
      if (!(await (this.owner.reachable?.(target) ?? true))) {
        return
      }
      // Why: a launch or select already publishing this target speaks for it.
      if (!this.current.has(key) && !this.pointers.busy(key)) {
        await this.publish(target, 'if-missing')
      }
    }
    this.backgroundPublishes.set(
      key,
      repair()
        .catch(() => {})
        .finally(() => this.backgroundPublishes.delete(key))
    )
  }
  /** The login Claude recorded in the account's profile, as last read; never a credential. */
  observedIdentity(accountId: string): ClaudeLoginIdentity | null {
    const state = this.owner.profileState(accountId)
    return state.readiness === 'ready' ? state.identity : null
  }

  async refreshForRead(
    target?: ClaudeAccountSelectionTarget,
    options?: { managedGuest?: boolean }
  ): Promise<void> {
    await this.owner.refresh?.(target, 'if-running', options)
  }
  accountHome(accountId: string): string {
    const { readiness } = this.owner.profileState(accountId)
    if (readiness !== 'ready') {
      throw readiness === 'sign-in-required'
        ? new ClaudeProfileSignInRequiredError()
        : new Error('Claude profile is unavailable.')
    }
    const home = this.owner.accountHome?.(accountId)
    if (!home) {
      throw new Error('Claude profile home is unavailable.')
    }
    return home
  }
  /** Never throws: readiness is per account, and a stale pointer is republished in the background. */
  describeAccounts(state: ClaudeRateLimitAccountsState): ClaudeRateLimitAccountsState {
    const accounts = withObservedClaudeIdentities(state.accounts, this.owner)
    const systemDefault = describeClaudeSystemDefaultFor(this.owner, accounts)
    const issues = this.currentPublishIssues()
    if (this.pointerIsCurrent()) {
      return {
        ...state,
        accounts,
        ...systemDefault,
        ...(issues ? { profileRoutingIssue: issues } : {})
      }
    }
    this.repair ??= this.publish(undefined, 'if-missing')
      .catch(() => {})
      .finally(() => {
        this.repair = null
      })
    return {
      ...state,
      accounts,
      ...systemDefault,
      profileRoutingIssue: issues || 'Claude account selection is being published'
    }
  }
  // Why: a target no longer routed (accounts removed, distro-less shell) has no publish to clear it.
  private currentPublishIssues(): string {
    const routed = new Set(['host', ...this.owner.targets().map(publishKey)])
    return [...this.publishIssues]
      .filter(([key]) => routed.has(key))
      .map(([, issue]) => issue)
      .join('; ')
  }
  private pointerIsCurrent(): boolean {
    try {
      const descriptor = this.resolve()
      return readClaudeProfilePointer(descriptor.pointerPath) === (descriptor.profile?.home ?? null)
    } catch {
      return false
    }
  }
  /** Never throws: skill roots for every provider read this, and only Claude launches may refuse
   *  an unresolvable account; a WSL distro not yet inspected this session reads the legacy home. */
  configDirOr(target: ClaudeAccountSelectionTarget | undefined, legacy: () => string): string {
    try {
      return this.resolve(target).readHome
    } catch {
      return legacy()
    }
  }
  historyRoots(
    target?: ClaudeAccountSelectionTarget,
    surface?: 'projects' | 'transcripts'
  ): string[] {
    return [...new Set(this.owner.readHomes(target, surface))]
  }
}

function publishKey(target?: ClaudeAccountSelectionTarget): string {
  return target?.runtime === 'wsl' ? `wsl:${target.wslDistro?.toLowerCase()}` : 'host'
}
