import type { CodexManagedAccount } from '../../shared/managed-account-types'
import type { Store } from '../persistence'
import { CodexCredentialAbsenceGrace } from './codex-credential-absence-grace'
import type {
  CodexMirroredHomeStatus,
  CodexRateLimitHomeResolution,
  CodexReadBackMatch,
  CodexRuntimeLogoutMarker,
  CodexRuntimeLogoutMarkerStatus,
  CodexSharedRuntimeAuthPendingProvenance,
  CodexSelfContainedManagedHomeResolution,
  CodexSharedRuntimeAuthProvenance,
  CodexSharedRuntimeAuthProvenanceFile,
  CodexSharedRuntimeAuthProvenanceStatus,
  CodexSystemDefaultSnapshot
} from './runtime-home-service-types'
import type { CodexSessionBackfillDate } from '../codex/codex-session-backfill-types'
import type { CodexAccountSelectionTarget } from './runtime-selection'
import type { LegacyWslRuntimeAuthDestination } from './legacy-wsl-runtime-auth-drain'
import type { WslCodexAuthRead } from './wsl-codex-auth-batch-reader'

export abstract class CodexRuntimeHomeState {
  // Mirror baseline owner; null means system default.
  protected lastSyncedAccountId: string | null = null
  // Differences from this baseline indicate an external login or Codex token refresh.
  protected lastWrittenAuthJson: string | null = null
  // Deselecting a self-contained account must not adopt stale shared-mirror credentials.
  protected lastHostAccountUsedSelfContainedHome = false
  protected sharedAuthRefreshBlockedByManagedTransition = false
  protected readonly credentialAbsenceGrace = new CodexCredentialAbsenceGrace()
  protected hostSystemDefaultSessionMigrationPending = false
  protected pendingHostSystemDefaultSessionMigrationNeedsFullScan = false
  protected pendingHostSystemDefaultSessionMigrationTarget: string | null = null

  protected constructor(protected readonly store: Store) {}

  protected abstract initializeLastSyncedState(): void
  abstract prepareForCodexLaunch(
    target?: CodexAccountSelectionTarget,
    launchEnv?: NodeJS.ProcessEnv,
    options?: {
      unavailableManagedHomePath?: string
      conversationHome?: string
      transcriptPath?: string
    }
  ): string | null
  abstract prepareForCodexLaunchAsync(
    target?: CodexAccountSelectionTarget,
    launchEnv?: NodeJS.ProcessEnv,
    options?: {
      unavailableManagedHomePath?: string
      conversationHome?: string
      transcriptPath?: string
    }
  ): Promise<string | null>
  abstract beginHostSystemDefaultSessionMigrationLaunch(
    codexHomePath: string | null,
    options?: { reattached?: boolean; launchEnv?: NodeJS.ProcessEnv }
  ): boolean | null
  abstract isHostSystemDefaultSessionMigrationEligible(): boolean
  abstract prepareHostSystemDefaultSessionMigrationPass(
    scanDates?: readonly CodexSessionBackfillDate[]
  ): boolean
  abstract finishHostSystemDefaultSessionMigrationPass(): void

  protected abstract getSelfContainedManagedHostAccount(): CodexManagedAccount | null
  protected abstract getManagedAccountHomesForSessionDiscovery(): string[]
  protected abstract getManagedHostAccountHomesForSessionDiscovery(): string[]
  protected abstract prepareSelfContainedManagedHomeForLaunch(
    account: CodexManagedAccount,
    unavailableManagedHomePath?: string
  ): string | null
  protected abstract syncSelfContainedManagedSelection(account: CodexManagedAccount): void
  protected abstract resolveSelfContainedManagedHome(
    account: CodexManagedAccount
  ): CodexSelfContainedManagedHomeResolution
  protected abstract getTrustedSelfContainedManagedHomePath(
    account: CodexManagedAccount
  ): string | null
  protected abstract clearSelfContainedManagedSelection(
    account: CodexManagedAccount,
    reason?: string
  ): void
  protected abstract invalidateBackfillAfterManagedSystemDefaultLaunch(
    launchEnv?: NodeJS.ProcessEnv
  ): boolean | null
  protected abstract startWslSessionBridgeForLaunch(
    target: CodexAccountSelectionTarget,
    runtimeHomePath: string | null
  ): void

  abstract getHostCodexHomePathsForSessionDiscovery(): string[]
  abstract getSelectedHostAccountCodexHomePath(): string | null
  abstract resolveSelectedHostAccountCodexHomePathForResume(): string | null
  abstract resolveCodexManagedAccountHomeForInactiveFetch(
    account: CodexManagedAccount
  ): { kind: 'ready'; homePath: string } | { kind: 'skip' }
  abstract getRetainedHostCodexHookHomePaths(ptyIds: readonly string[]): string[]
  abstract isHostSystemDefaultRealHomeSelected(launchEnv?: NodeJS.ProcessEnv): boolean
  abstract reconcileLegacySharedHomeForRetainedPanes(): void
  abstract syncActiveWslSelectionsBeforeRestart(): Promise<void>

  protected abstract getWslSystemCodexHomePath(target: CodexAccountSelectionTarget): string | null
  protected abstract finishWslLaunchPreparation(
    target: CodexAccountSelectionTarget,
    homePath: string | null
  ): void
  protected abstract syncWslConfigAndGlobalInstructionsForLaunch(
    target: CodexAccountSelectionTarget,
    runtimeHomePath: string | null
  ): void
  abstract prepareForRateLimitFetch(
    target?: CodexAccountSelectionTarget
  ): CodexRateLimitHomeResolution
  abstract syncForCurrentSelection(
    target?: CodexAccountSelectionTarget,
    launchEnv?: NodeJS.ProcessEnv
  ): void
  abstract clearLastWrittenAuthJson(accountId?: string | null): void

  protected abstract resolveSystemDefaultMirrorClaim(
    runtimeAuth: string,
    provenanceStatus: CodexSharedRuntimeAuthProvenanceStatus
  ): { ownershipProven: boolean; mirroredAuthJson: string | null }
  protected abstract safeSyncForCurrentSelection(): void
  protected abstract safeRecoverInterruptedRuntimeAuthOperation(): void
  protected abstract getActiveAccount(
    accounts: CodexManagedAccount[],
    activeAccountId: string | null
  ): CodexManagedAccount | null
  protected abstract getWslManagedHomePath(account: CodexManagedAccount | null): string | null
  protected abstract getWslManagedHomeIdentity(
    account: CodexManagedAccount | null
  ): { distro: string; linuxHomePath: string } | null
  protected abstract getPreparedWslRateLimitHomePath(
    target: CodexAccountSelectionTarget
  ): string | null
  protected abstract getWslCodexHomePathForSelection(
    target: CodexAccountSelectionTarget
  ): string | null
  protected abstract getWslLaunchCodexHomePath(
    account: CodexManagedAccount,
    targetDistro: string | undefined
  ): string | null
  protected abstract startLegacyWslAuthDrain(
    target: CodexAccountSelectionTarget,
    options?: { throwOnFailure?: boolean }
  ): Promise<void>
  protected abstract resolveLegacyWslAuthDestination(
    distro: string,
    runtimeAuthContents: string
  ): Promise<LegacyWslRuntimeAuthDestination | null>
  protected abstract joinWslPath(basePath: string, ...segments: string[]): string
  protected abstract resolveWslDefaultTarget(
    target: CodexAccountSelectionTarget
  ): CodexAccountSelectionTarget
  protected abstract findManagedAccountForRuntimeAuth(
    runtimeAuthContents: string,
    expectedAccountId?: string,
    options?: {
      accounts: readonly CodexManagedAccount[]
      authReads: ReadonlyMap<string, WslCodexAuthRead>
    }
  ): CodexReadBackMatch
  protected abstract runtimeAuthMatchesSystemDefaultIdentity(
    runtimeAuthContents: string,
    systemDefaultAuthContents: string
  ): boolean

  protected abstract safeMigrateLegacySharedAuth(): void
  protected abstract safeMigrateLegacyManagedState(): void
  protected abstract safeMigrateLegacyActiveHomePointer(): void
  protected abstract getRuntimeHomePath(): string
  abstract getMirroredHostHomePathForStatus(): CodexMirroredHomeStatus
  protected abstract getRuntimeAuthPath(): string
  protected abstract getSystemDefaultSnapshotPath(): string
  protected abstract getRuntimeLogoutMarkerPath(): string
  protected abstract getSharedRuntimeAuthProvenancePath(): string
  protected abstract getRuntimeMetadataDir(): string
  protected abstract getLegacyHostActiveHomePath(): string
  protected abstract getMigrationMarkerPath(): string
  protected abstract getMigrationDiagnosticsPath(): string
  protected abstract getManagedAccountsRoot(): string
  protected abstract repointLegacyActiveHomePointer(
    activeHomePath: string,
    runtimeHomePath: string
  ): void
  protected abstract activeHomeAlreadyPointsToRuntimeHome(
    activeHomePath: string,
    runtimeHomePath: string
  ): boolean
  protected abstract linkTargetsMatch(
    linkTarget: string,
    linkPath: string,
    expectedTargetPath: string
  ): boolean
  protected abstract legacyActiveHomeLinkIsReplaceable(activeHomePath: string): boolean
  protected abstract legacyActiveHomePathExists(activeHomePath: string): boolean
  protected abstract removeLegacyActiveHomeLinkIfOwned(activeHomePath: string): void
  protected abstract isWindowsReadableLink(targetPath: string): boolean
  protected abstract migrateLegacyManagedStateIfNeeded(): void
  protected abstract getLegacyManagedHomes(): string[]
  protected abstract migrateLegacyHistory(managedHomePath: string): void
  protected abstract migrateLegacySessions(managedHomePath: string, accountId: string): void
  protected abstract listFilesRecursively(rootPath: string): string[]
  protected abstract appendListedFiles(target: string[], source: readonly string[]): void
  protected abstract getPreservedLegacySessionPath(
    runtimeFilePath: string,
    accountId: string
  ): string
  protected abstract appendMigrationDiagnostic(record: Record<string, string>): void

  protected abstract captureSystemDefaultSnapshot(options: { force: boolean }): void
  protected abstract syncRuntimeAuthWithSystemDefault(): void
  protected abstract syncLegacySharedSystemDefaultAuthForRetainedPanes(): void
  protected abstract restoreSystemDefaultSnapshot(options: { detectExternalLogin: boolean }): void
  protected abstract writeSystemDefaultAuth(
    contents: string,
    options?: { expectedContents: string | null }
  ): boolean
  protected abstract clearRuntimeAuthAfterSystemDefaultLogout(runtimeAuthPath: string): void
  protected abstract readSystemDefaultAuth(): string | null
  protected abstract writeRuntimeAuth(
    contents: string,
    owner: { owner: 'system-default' } | { owner: 'managed'; accountId: string },
    options?: { expectedContents: string | null }
  ): boolean
  protected abstract compareFileContents(targetPath: string, contents: string): boolean | null
  protected abstract fileContentsEqual(targetPath: string, contents: string): boolean
  protected abstract fileContentsMatchExpected(
    targetPath: string,
    expectedContents: string | null
  ): boolean
  protected abstract ensureOwnerOnlyMode(targetPath: string): void
  protected abstract getRuntimeLogoutMarkerStatus(): CodexRuntimeLogoutMarkerStatus
  protected abstract persistRuntimeLogoutMarker(systemDefaultAuthJson?: string | null): void
  protected abstract readRuntimeLogoutMarker(): CodexRuntimeLogoutMarker | null
  protected abstract clearRuntimeLogoutMarker(): void
  protected abstract persistSharedRuntimeAuthProvenance(
    provenance: CodexSharedRuntimeAuthProvenanceFile
  ): void
  protected abstract markSharedRuntimeAuthManaged(accountId: string): void
  protected abstract getUntouchedSystemDefaultBaseline(
    status: CodexSharedRuntimeAuthProvenanceStatus,
    runtimeAuthJson: string | null
  ): { authJson: string | null } | null
  protected abstract restoreUntouchedSystemDefaultProvenance(
    provenance: Extract<CodexSharedRuntimeAuthProvenance, { owner: 'managed' }>
  ): Extract<CodexSharedRuntimeAuthProvenance, { owner: 'system-default' }> | null
  protected abstract sharedRuntimeAuthProvenanceMatches(
    status: CodexSharedRuntimeAuthProvenanceStatus,
    expected: CodexSharedRuntimeAuthProvenance
  ): boolean
  protected abstract resolveSharedRuntimeAuthProvenanceStatus(): CodexSharedRuntimeAuthProvenanceStatus
  protected abstract parseSharedRuntimeAuthProvenance(
    value: unknown
  ): CodexSharedRuntimeAuthProvenance | null
  protected abstract parseSystemDefaultBaseline(value: unknown): { authJson: string | null } | null
  protected abstract parsePendingSharedRuntimeAuthProvenance(
    value: unknown
  ): CodexSharedRuntimeAuthPendingProvenance | null
  protected abstract readRuntimeAuthForProvenance(): string | null
  protected abstract readSystemDefaultSnapshot(
    snapshotPath: string
  ): CodexSystemDefaultSnapshot | null
  abstract clearSystemDefaultSnapshot(): void
}
