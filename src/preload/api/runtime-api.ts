import type {
  RuntimeBrowserDriverState,
  RuntimeRendererSyncWindowGraph,
  RuntimeStatus,
  RuntimeSyncWindowGraphResult,
  RuntimeTerminalDriverState
} from '../../shared/runtime-types'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { PublicKnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { VerifyAndAddRuntimeEnvironmentResult } from '../../shared/remote-pairing-verification'

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
    call: (args: { method: string; params?: unknown }) => Promise<RuntimeRpcResponse<unknown>>
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
  }
  runtimeEnvironments: {
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
    }) => Promise<RuntimeRpcResponse<RuntimeStatus>>
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
