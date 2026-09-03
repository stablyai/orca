import { ipcRenderer } from 'electron'
import type { AgentSessionPtyWriteRefusal } from '../../shared/agent-session-pty-write-admission'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { StartupCommandDelivery } from '../../shared/codex-startup-delivery'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../shared/agent-session-resume'
import type { TuiAgent } from '../../shared/tui-agent'
import type { PtyListedSession } from '../../shared/pty-listed-session'
import type {
  PtyRendererDeliveryHealthReply,
  PtyRendererDeliveryStateReport
} from '../../shared/pty-renderer-delivery-health'
import type { TerminalViewAttributes } from '../../shared/terminal-view-attributes'
import type { PtyMainDeliveryDiagnostics } from '../../shared/pty-delivery-diagnostics'
import type { AgentKind, LaunchSource, RequestKind } from '../../shared/telemetry-events'
import type { PreloadApi } from '../api-types'

export const ptySessionControlApi = {
  spawn: (opts: {
    cols: number
    rows: number
    cwd?: string
    cwdFallback?: 'worktree'
    env?: Record<string, string>
    envToDelete?: string[]
    command?: string
    commandDelivery?: 'renderer' | 'provider'
    launchConfig?: SleepingAgentLaunchConfig
    resumeProviderSession?: AgentProviderSessionMetadata
    launchToken?: string
    launchAgent?: TuiAgent
    startupCommandDelivery?: StartupCommandDelivery
    connectionId?: string | null
    worktreeId?: string
    sessionId?: string
    shellOverride?: string
    projectRuntime?: ProjectExecutionRuntimeResolution
    terminalColorQueryReplies?: { foreground?: string; background?: string }
    // Why: marks the PTY hidden before its first byte so the delivery gate + model responder own spawn-time queries (terminal-query-authority.md §races).
    initiallyHidden?: boolean
    // Why: closes the SIGKILL race (INVESTIGATION.md) — main sync-flushes the (worktreeId, tabId, leafId → ptyId) binding before pty:spawn returns.
    tabId?: string
    leafId?: string
    // Why: loose typing on purpose — renderer owns launch metadata, main owns whether the launch happened and validates (telemetry-plan.md §Agent launch semantics).
    telemetry?: { agent_kind: AgentKind; launch_source: LaunchSource; request_kind: RequestKind }
  }): Promise<{
    id: string
    /** Which lifetime of `id` this reply named; absent when the execution host predates the field. */
    incarnationId?: string
    launchConfig?: SleepingAgentLaunchConfig
    snapshot?: string
    snapshotCols?: number
    snapshotRows?: number
    snapshotPrefixAnsi?: string
    snapshotFrameAnsi?: string
    snapshotFrameRestoreAnsi?: string
    snapshotKittyKeyboardFlags?: number
    snapshotTerminalOwner?: 'shell'
    snapshotSeq?: number
    isReattach?: boolean
    isAlternateScreen?: boolean
    replay?: string
    sessionExpired?: boolean
    coldRestore?: { scrollback: string; cwd: string; cols?: number; rows?: number }
    startupCwdFallback?: { kind: 'worktree'; cwd: string }
    agentResumeUnavailable?: true
  }> => ipcRenderer.invoke('pty:spawn', opts),
  write: (id: string, data: string): void => {
    ipcRenderer.send('pty:write', { id, data })
  },
  writeAccepted: (id: string, data: string): Promise<boolean> =>
    ipcRenderer.invoke('pty:writeAccepted', { id, data }),
  onWriteUnavailable: (
    callback: (payload: {
      id: string
      /** Set only when a durable agent-session lease refused the write; absent otherwise. */
      agentSessionRefusal?: AgentSessionPtyWriteRefusal
    }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { id: string; agentSessionRefusal?: AgentSessionPtyWriteRefusal }
    ): void => callback(payload)
    ipcRenderer.on('pty:writeUnavailable', handler)
    return () => ipcRenderer.removeListener('pty:writeUnavailable', handler)
  },
  resize: (id: string, cols: number, rows: number): void => {
    ipcRenderer.send('pty:resize', { id, cols, rows })
  },
  claimViewport: (id: string, cols: number, rows: number): void => {
    ipcRenderer.send('pty:claimViewport', { id, cols, rows })
  },
  reportGeometry: (id: string, cols: number, rows: number): void => {
    ipcRenderer.send('pty:reportGeometry', { id, cols, rows })
  },
  signal: (id: string, signal: string): void => {
    ipcRenderer.send('pty:signal', { id, signal })
  },
  clearBuffer: (id: string): void => {
    ipcRenderer.send('pty:clearBuffer', { id })
  },
  ackColdRestore: (id: string): void => {
    ipcRenderer.send('pty:ackColdRestore', { id })
  },
  ackData: (id: string, charCount: number, processedChars?: number): void => {
    ipcRenderer.send('pty:ackData', {
      id,
      charCount,
      ...(typeof processedChars === 'number' ? { processedChars } : {})
    })
  },
  onDeliveryResyncRequest: (callback: (payload: { requestId: number }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { requestId: number }) =>
      callback(payload)
    ipcRenderer.on('pty:requestDeliveryResync', listener)
    return () => ipcRenderer.removeListener('pty:requestDeliveryResync', listener)
  },
  respondDeliveryResync: (payload: {
    requestId: number
    processedCharsByPty: Record<string, number>
  }): void => {
    ipcRenderer.send('pty:deliveryResyncResponse', payload)
  },
  reportRendererDeliveryState: (
    report: PtyRendererDeliveryStateReport
  ): Promise<PtyRendererDeliveryHealthReply> =>
    ipcRenderer.invoke('pty:reportRendererDeliveryState', report),
  getPtyDataListenerCount: (): number => ipcRenderer.listenerCount('pty:data'),
  rendererDispatcherReady: (): void => {
    ipcRenderer.send('pty:rendererDispatcherReady')
  },
  setActiveRendererPty: (id: string, active: boolean): void => {
    ipcRenderer.send('pty:setActiveRendererPty', { id, active })
  },
  setRendererPtyVisible: (id: string, visible: boolean): void => {
    ipcRenderer.send('pty:setRendererPtyVisible', { id, visible })
  },
  setHiddenRendererPty: (id: string, hidden: boolean): void => {
    ipcRenderer.send('pty:setHiddenRendererPty', { id, hidden })
  },
  setPtyDeliveryInterest: (id: string, interested: boolean): void => {
    ipcRenderer.send('pty:setPtyDeliveryInterest', { id, interested })
  },
  publishTerminalViewAttributes: (attributes: TerminalViewAttributes): void => {
    ipcRenderer.send('pty:terminalViewAttributes', attributes)
  },
  kill: (id: string, opts?: { keepHistory?: boolean }): Promise<void> =>
    ipcRenderer.invoke('pty:kill', { id, keepHistory: opts?.keepHistory ?? false }),
  listSessions: (): Promise<PtyListedSession[]> => ipcRenderer.invoke('pty:listSessions'),
  getAuthoritativeBufferSnapshotCapabilities: (
    ids: string[]
  ): Promise<{ id: string; authoritative: boolean | null }[]> =>
    ipcRenderer.invoke('pty:getAuthoritativeBufferSnapshotCapabilities', { ids }),
  hasPty: (id: string): Promise<boolean | null> => ipcRenderer.invoke('pty:hasPty', { id }),
  getMainBufferSnapshot: (
    id: string,
    opts?: { scrollbackRows?: number }
  ): Promise<{
    data: string
    frameRestoreAnsi?: string
    cols: number
    rows: number
    cwd?: string | null
    seq?: number
    pendingDeliveryStartSeq?: number
    source?: 'headless' | 'renderer'
    alternateScreen?: boolean
    scrollbackAnsi?: string
    pendingEscapeTailAnsi?: string
    kittyKeyboardFlags?: number
    terminalOwner?: 'shell'
  } | null> => ipcRenderer.invoke('pty:getMainBufferSnapshot', { id, opts }),
  getRendererDeliveryDebugSnapshot: (): Promise<{
    pendingPtyCount: number
    pendingChars: number
    maxPendingCharsByPty: number
    rendererInFlightPtyCount: number
    rendererInFlightChars: number
    maxRendererInFlightCharsByPty: number
    activeRendererPtyCount: number
    flushScheduled: boolean
    peakPendingChars: number
    peakMaxPendingCharsByPty: number
    peakRendererInFlightChars: number
    peakMaxRendererInFlightCharsByPty: number
    ackGatedFlushSkipCount: number
    hiddenDeliveryGatedPtyCount: number
    hiddenDeliveryGatedVisiblePtyCount: number
    hiddenDeliveryGatedActivePtyCount: number
    deliveryInterestPtyCount: number
    hiddenDeliveryDroppedChars: number
    hiddenDeliveryDroppedChunks: number
    pendingDroppedChars: number
    diagnostics: PtyMainDeliveryDiagnostics
    rendererLifecycleResetCount: number
    lastLifecycleResetClearedChars: number
    rendererPtyDispatcherReady: boolean
    rendererDispatcherReadyForcedCount: number
  }> => ipcRenderer.invoke('pty:getRendererDeliveryDebugSnapshot'),
  resetRendererDeliveryDebug: (): Promise<void> =>
    ipcRenderer.invoke('pty:resetRendererDeliveryDebug'),
  hasChildProcesses: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('pty:hasChildProcesses', { id }),
  getForegroundProcess: (id: string): Promise<string | null> =>
    ipcRenderer.invoke('pty:getForegroundProcess', { id })
} satisfies Partial<PreloadApi['pty']>
