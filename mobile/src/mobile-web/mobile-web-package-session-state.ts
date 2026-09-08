import type { MobileWebShellSession } from '@orca/expo-mobile-web-shell'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileWebPackageDownloadProgress } from './mobile-web-package-downloader'
import type { MobileWebShellNotice } from './mobile-web-shell-notice'

export type MobileWebPackageCapabilityStatus =
  | 'offline'
  | 'pending'
  | 'supported'
  | 'update-required'

export type MobileWebPackageCapability = {
  status: MobileWebPackageCapabilityStatus
  gzip: boolean
  range: boolean
}

/** What the runtime capability probe answered, and for which client/connection it answered it. */
export type ResolvedMobileWebPackageCapability = {
  client: RpcClient
  hostId: string
  connectionId: number | null
  supported: boolean
  gzip: boolean
  range: boolean
}

export type MobileWebPackageState = {
  session: MobileWebShellSession | null
  sessionHostId: string | undefined
  viewEpoch: number
  /** Bumped whenever the cached generation must be opened and refreshed from scratch. */
  loadEpoch: number
  loading: boolean
  progress: MobileWebPackageDownloadProgress | undefined
  warning: MobileWebShellNotice | undefined
  resolvedCapability: ResolvedMobileWebPackageCapability | null
}

export type MobileWebPackageAction =
  | { type: 'reopening'; hasHost: boolean }
  | { type: 'capability-resolved'; capability: ResolvedMobileWebPackageCapability }
  | { type: 'session-published'; session: MobileWebShellSession; hostId: string }
  | { type: 'download-started' }
  | { type: 'download-progress'; progress: MobileWebPackageDownloadProgress }
  | { type: 'download-settled'; warning?: MobileWebShellNotice }
  | { type: 'warning'; warning: MobileWebShellNotice }
  | { type: 'view-restarted'; warning: MobileWebShellNotice }
  | { type: 'generation-dropping'; warning: MobileWebShellNotice }
  | { type: 'reload' }

export const initialMobileWebPackageState: MobileWebPackageState = {
  session: null,
  sessionHostId: undefined,
  viewEpoch: 0,
  loadEpoch: 0,
  loading: false,
  progress: undefined,
  warning: undefined,
  resolvedCapability: null
}

export function mobileWebPackageReducer(
  state: MobileWebPackageState,
  action: MobileWebPackageAction
): MobileWebPackageState {
  switch (action.type) {
    // Dispatched by the effect that re-opens the cache, so the published session is cleared
    // exactly when it is about to be replaced and never on an unrelated render.
    case 'reopening':
      return {
        ...initialMobileWebPackageState,
        loadEpoch: state.loadEpoch,
        resolvedCapability: state.resolvedCapability,
        loading: action.hasHost
      }
    case 'capability-resolved':
      return { ...state, resolvedCapability: action.capability }
    case 'session-published':
      return {
        ...state,
        session: action.session,
        sessionHostId: action.hostId,
        viewEpoch: 0,
        loading: false,
        progress: undefined
      }
    case 'download-started':
      return { ...state, loading: true, progress: undefined, warning: undefined }
    case 'download-progress':
      return { ...state, progress: action.progress }
    case 'download-settled':
      return { ...state, loading: false, progress: undefined, warning: action.warning }
    case 'warning':
      return { ...state, warning: action.warning }
    case 'view-restarted':
      return { ...state, viewEpoch: state.viewEpoch + 1, warning: action.warning }
    case 'generation-dropping':
      return {
        ...state,
        session: null,
        sessionHostId: undefined,
        viewEpoch: 0,
        loading: true,
        progress: undefined,
        warning: action.warning
      }
    // Separate from the drop so the cache is actually gone before the effects re-open it.
    case 'reload':
      return { ...state, loadEpoch: state.loadEpoch + 1 }
  }
}

export function mobileWebPackageCapability(
  state: MobileWebPackageState,
  args: { client: RpcClient | null; hostId: string | undefined; connected: boolean }
): MobileWebPackageCapability {
  const resolved = state.resolvedCapability
  if (!args.connected) {
    return { status: 'offline', gzip: false, range: false }
  }
  if (
    !args.client ||
    !args.hostId ||
    resolved?.client !== args.client ||
    resolved.hostId !== args.hostId ||
    resolved.connectionId !== currentConnectionId(args.client)
  ) {
    return { status: 'pending', gzip: false, range: false }
  }
  return {
    status: resolved.supported ? 'supported' : 'update-required',
    gzip: resolved.gzip,
    range: resolved.range
  }
}

export function currentConnectionId(client: RpcClient | null): number | null {
  return client && typeof client.getLastConnectedAt === 'function'
    ? client.getLastConnectedAt()
    : null
}

/** What the hybrid screen consumes; the shell owns recovery, so nothing here is user-triggered. */
export type MobileWebPackageSession = {
  session: MobileWebShellSession | null
  sessionHostId: string | undefined
  viewEpoch: number
  packageLoading: boolean
  packageProgress: MobileWebPackageDownloadProgress | undefined
  packageWarning: MobileWebShellNotice | undefined
  handleLoadFailure: (reason: string | undefined) => void
  handleProcessTerminated: (sessionId: string) => void
  showWarning: (message: string, code?: string) => void
}
