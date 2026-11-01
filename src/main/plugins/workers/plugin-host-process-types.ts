import type { PluginCapabilityKind } from '../../../shared/plugins/capabilities/plugin-capabilities'
import type { PluginEventName } from '../../../shared/plugins/manifest/plugin-manifest'
import type {
  PluginErrorCode,
  PluginHostCallOutcome
} from '../../../shared/plugins/frames/plugin-protocol'
import type {
  PluginDataChanged,
  PluginPanelCaller,
  PluginWorkerPanelPost
} from '../../../shared/plugins/workers/plugin-panel-bridge-protocol'

/** A worker answer that failed, with the code the worker (or the host) gave. */
export type PluginWorkerRequestError = Error & { code: PluginErrorCode }

export type PluginWorkerPanelRequest = {
  name: string
  input: unknown
  panel: PluginPanelCaller
  timeoutMs: number
  signal?: AbortSignal
}

export type PluginWorkerLogSink = (level: 'info' | 'warn' | 'error', line: string) => void

export type PluginWorkerHostCallExecutor = (
  method: string,
  params: unknown
) => Promise<PluginHostCallOutcome>

export type PluginWorkerHandle = {
  /** Command ids the worker registered on activate (⊆ manifest commands). */
  commands: readonly string[]
  invokeCommand(commandId: string, args?: unknown): Promise<unknown>
  deliverEvent(event: PluginEventName, payload: unknown): void
  /** A panel's `plugin.request`; rejects with a {@link PluginWorkerRequestError}. */
  requestFromPanel(request: PluginWorkerPanelRequest): Promise<unknown>
  /** Fire-and-forget: the worker's `storage`/`settings` `onDidChange` listeners. */
  notifyDataChanged(change: PluginDataChanged): void
  /** Last completed work timestamp, in milliseconds, for idle reaping. */
  lastActivityAt(): number
  inFlightCount(): number
  dispose(): Promise<void>
  kill(): void
  onExit(callback: (code: number | null) => void): void
}

export type StartPluginWorkerOptions = {
  pluginId: string
  rootDir: string
  mainEntry: string
  /** Caller-resolved compiled entry path. */
  entryPath: string
  grantedCapabilities: readonly PluginCapabilityKind[]
  executeHostCall: PluginWorkerHostCallExecutor
  /** `orca.panels.post` from this worker, already shape-checked. */
  onPanelPost?: (post: PluginWorkerPanelPost) => void
  log: PluginWorkerLogSink
  readyTimeoutMs?: number
  invokeTimeoutMs?: number
  eventTimeoutMs?: number
  signal?: AbortSignal
}
