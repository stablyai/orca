import type { RuntimeHostStatusSnapshot } from '../../shared/runtime-host-status'
import type {
  OrcadLiveMigrationProgress,
  OrcadLiveMigrationResumeSelection
} from '../../shared/orcad-live-migration-recovery'
import type {
  RuntimeEnvironmentReconciliationRequest,
  RuntimeEnvironmentReconciliationResult
} from '../../shared/runtime-environment-reconciliation-request'
import type {
  RuntimeSshAccessLinkRequest,
  RuntimeSshAccessUnlinkRequest
} from '../../shared/runtime-ssh-access'
import type {
  RuntimeBrowserDriverState,
  RuntimeRendererSyncWindowGraph,
  RuntimeStatus,
  RuntimeSyncWindowGraphResult,
  RuntimeTerminalDriverState
} from '../../shared/runtime-types'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { ClientHostedBrowserRowsEvent } from '../../shared/client-hosted-browser-rows'
import type { PublicKnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { VerifyAndAddRuntimeEnvironmentResult } from '../../shared/remote-pairing-verification'
import type {
  OrcadManagedDeployResult,
  OrcadManagedPendingMigration,
  OrcadManagedRecoveryResult,
  OrcadManagedCancelStopResult,
  OrcadManagedRollbackResult,
  OrcadManagedRuntimeStatus,
  OrcadManagedStopResult
} from '../../shared/orcad-managed-runtime'
import type { OrcadMigrationPreflight } from '../../shared/orcad-migration-preflight'
import type {
  OrcadSshPendingProvisioning,
  OrcadSshProvisioningRequest,
  OrcadSshProvisioningResult
} from '../../shared/orcad-ssh-provisioning'
import type {
  BrowserClientHostPlacementPreparationRequest,
  BrowserPageCreationPlacement
} from '../../shared/browser-client-host-placement'
import type {
  PtyOwnershipTransferExecuteRequest,
  PtyOwnershipTransferExecuteResult,
  PtyOwnershipTransferPreflightRequest,
  PtyOwnershipTransferPreflightResult,
  PtyOwnershipTransferStatusProbeRequest
} from '../../shared/pty-ownership-transfer-orchestration'
import type { PtyOwnershipTransferStatusResult } from '../../shared/pty-ownership-transfer-wire'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../shared/remote-runtime-shared-control-types'
import type {
  OrcadLiveMigrationRendererPlan,
  OrcadLiveMigrationRendererPlanSelection
} from '../../shared/orcad-live-migration-renderer-plan'

export type RuntimeEnvironmentSubscriptionHandle = {
  unsubscribe: () => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
}

export type RuntimeApi = {
  runtime: {
    syncWindowGraph: (
      graph: RuntimeRendererSyncWindowGraph
    ) => Promise<RuntimeSyncWindowGraphResult>
    getStatus: () => Promise<RuntimeStatus>
    transferPtyOwnership?: (
      request: PtyOwnershipTransferExecuteRequest
    ) => Promise<PtyOwnershipTransferExecuteResult>
    preflightPtyOwnershipTransfer?: (
      request: PtyOwnershipTransferPreflightRequest
    ) => Promise<PtyOwnershipTransferPreflightResult>
    getPtyOwnershipTransferStatus?: (
      request: PtyOwnershipTransferStatusProbeRequest
    ) => Promise<PtyOwnershipTransferStatusResult>
    call: (args: { method: string; params?: unknown }) => Promise<RuntimeRpcResponse<unknown>>
    subscribe: (
      args: { method: string; params?: unknown },
      callback: (response: RuntimeRpcResponse<unknown>) => void
    ) => Promise<RuntimeEnvironmentSubscriptionHandle>
    getTerminalFitOverrides: () => Promise<
      { ptyId: string; mode: 'mobile-fit' | 'remote-desktop-fit'; cols: number; rows: number }[]
    >
    getTerminalDrivers: () => Promise<
      {
        ptyId: string
        driver: RuntimeTerminalDriverState
      }[]
    >
    getBrowserDrivers: () => Promise<
      {
        browserPageId: string
        driver: RuntimeBrowserDriverState
      }[]
    >
    getBrowserRemoteViewerPages?: () => Promise<string[]>
    getClientHostedBrowserRows: () => Promise<ClientHostedBrowserRowsEvent[]>
    restoreTerminalFit: (ptyId: string) => Promise<{ restored: boolean }>
    reclaimBrowserForDesktop: (browserPageId: string) => Promise<{ reclaimed: boolean }>
    onTerminalFitOverrideChanged: (
      callback: (event: {
        ptyId: string
        mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
        cols: number
        rows: number
      }) => void
    ) => () => void
    onTerminalDriverChanged: (
      callback: (event: { ptyId: string; driver: RuntimeTerminalDriverState }) => void
    ) => () => void
    onNativeChatLaunchDraftResolved?: (
      callback: (event: { tabId: string; text: string; createdAt: number }) => void
    ) => () => void
    onBrowserDriverChanged: (
      callback: (event: { browserPageId: string; driver: RuntimeBrowserDriverState }) => void
    ) => () => void
    // Why optional: matches onNativeChatLaunchDraftResolved — a renderer running against an older
    // preload keeps working without the retention signal instead of throwing on every mount.
    onBrowserRemoteViewersChanged?: (
      callback: (event: { browserPageId: string; hasRemoteViewers: boolean }) => void
    ) => () => void
    onClientHostedBrowserRowsChanged: (
      callback: (event: ClientHostedBrowserRowsEvent) => void
    ) => () => void
  }
  runtimeEnvironments: {
    getStatusSnapshots: () => Promise<RuntimeHostStatusSnapshot[]>
    onStatusChanged: (callback: (snapshot: RuntimeHostStatusSnapshot) => void) => () => void
    reconcile: (
      args: RuntimeEnvironmentReconciliationRequest
    ) => Promise<RuntimeEnvironmentReconciliationResult>
    list: () => Promise<PublicKnownRuntimeEnvironment[]>
    addFromPairingCode: (args: {
      name: string
      pairingCode: string
    }) => Promise<{ environment: PublicKnownRuntimeEnvironment }>
    verifyAndAddFromPairingCode: (args: {
      name: string
      pairingCode: string
      allowLoopback?: boolean
    }) => Promise<VerifyAndAddRuntimeEnvironmentResult>
    resolve: (args: { selector: string }) => Promise<PublicKnownRuntimeEnvironment>
    listPendingOrcadMigrations: () => Promise<OrcadManagedPendingMigration[]>
    createOrcadSshHost: (args: OrcadSshProvisioningRequest) => Promise<OrcadSshProvisioningResult>
    resumeOrcadSshHost: (args: { requestId: string }) => Promise<OrcadSshProvisioningResult>
    listPendingOrcadSshProvisioning: () => Promise<OrcadSshPendingProvisioning[]>
    linkSshAccess: (args: RuntimeSshAccessLinkRequest) => Promise<PublicKnownRuntimeEnvironment>
    unlinkSshAccess: (args: RuntimeSshAccessUnlinkRequest) => Promise<PublicKnownRuntimeEnvironment>
    preflightOrcadTarget: (args: { sshTargetId: string }) => Promise<OrcadMigrationPreflight>
    deployOrcad: (args: {
      name: string
      sshTargetId: string
      force?: boolean
    }) => Promise<OrcadManagedDeployResult>
    updateOrcad: (args: { selector: string; force?: boolean }) => Promise<OrcadManagedDeployResult>
    getOrcadStatus: (args: { selector: string }) => Promise<OrcadManagedRuntimeStatus>
    rollbackOrcad: (args: { selector: string }) => Promise<OrcadManagedRollbackResult>
    recoverOrcad: (args: { selector: string }) => Promise<OrcadManagedRecoveryResult>
    listOrcadLiveMigrations: (args: { selector: string }) => Promise<OrcadLiveMigrationProgress[]>
    getOrcadLiveMigrationRendererPlan: (
      args: OrcadLiveMigrationRendererPlanSelection
    ) => Promise<OrcadLiveMigrationRendererPlan>
    startOrcadLiveMigration: (args: {
      selector: string
      targetId: string
    }) => Promise<OrcadLiveMigrationProgress>
    resumeOrcadLiveMigration: (
      args: OrcadLiveMigrationResumeSelection
    ) => Promise<OrcadLiveMigrationProgress>
    listOrcadOutgoingCaptures: (args: {
      selector: string
      includePreparations?: boolean
    }) => Promise<OrcadOutgoingRecoveryCandidate[]>
    recoverOrcadOutgoingCapture: (args: {
      selector: string
      bridgeId: string
      stage?: 'capture' | 'preparation'
    }) => Promise<OrcadOutgoingRecoveryResult>
    prepareOrcadOutgoingTerminal: (
      args: OrcadOutgoingPreparationRequest
    ) => Promise<OrcadOutgoingRecoveryResult>
    cancelOrcadStop: (args: { selector: string }) => Promise<OrcadManagedCancelStopResult>
    stopOrcad: (args: { selector: string }) => Promise<OrcadManagedStopResult>
    remove: (args: { selector: string }) => Promise<{ removed: PublicKnownRuntimeEnvironment }>
    disconnect: (args: {
      selector: string
    }) => Promise<{ disconnected: PublicKnownRuntimeEnvironment }>
    connect: (args: {
      selector: string
      timeoutMs?: number
    }) => Promise<RuntimeRpcResponse<RuntimeStatus>>
    getStatus: (args: {
      selector: string
      timeoutMs?: number
      observeOnly?: true
    }) => Promise<RuntimeRpcResponse<RuntimeStatus>>
    retryControlConnection?: (args: { selector: string }) => Promise<void>
    onSharedControlDiagnostics?: (
      callback: (event: {
        environmentId: string
        transportGeneration: number
        diagnostics: RemoteRuntimeSharedConnectionDiagnostics
      }) => void
    ) => () => void
    prepareBrowserClientHostPlacement: (
      args: BrowserClientHostPlacementPreparationRequest
    ) => Promise<BrowserPageCreationPlacement>
    // Why: system resume / browser online advance pending shared-control reconnect timers only.
    retryConnectionsNow?: () => Promise<void>
    call: (args: {
      selector: string
      method: string
      params?: unknown
      timeoutMs?: number
      expectedEnvironmentPairingRevision?: number
    }) => Promise<RuntimeRpcResponse<unknown>>
    subscribe: (
      args: {
        selector: string
        method: string
        params?: unknown
        timeoutMs?: number
        expectedEnvironmentPairingRevision?: number
      },
      callbacks: {
        onResponse: (response: RuntimeRpcResponse<unknown>) => void
        onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
        onError?: (error: { code: string; message: string }) => void
        onClose?: () => void
      }
    ) => Promise<RuntimeEnvironmentSubscriptionHandle>
  }
  wsl: {
    isAvailable: () => Promise<boolean>
    listDistros: () => Promise<string[]>
  }
  pwsh: {
    isAvailable: () => Promise<boolean>
  }
  gitBash: {
    isAvailable: () => Promise<boolean>
  }
}
import type {
  OrcadOutgoingPreparationRequest,
  OrcadOutgoingRecoveryCandidate,
  OrcadOutgoingRecoveryResult
} from '../../shared/orcad-outgoing-recovery'
