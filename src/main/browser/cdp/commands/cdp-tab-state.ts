import type {
  BrowserConsoleEntry,
  BrowserInterceptedRequest,
  BrowserNetworkEntry
} from '../../../../shared/runtime-browser-contracts'
import type { SnapshotResult } from '../snapshots/snapshot-engine'

export type CdpTabState = {
  navigationId: string | null
  snapshotResult: SnapshotResult | null
  debuggerAttached: boolean
  debuggerDetachListener: (() => void) | null
  debuggerMessageListener: ((_event: unknown, method: string, params: unknown) => void) | null
  iframeSessions: Map<string, string>
  capturing: boolean
  consoleLog: BrowserConsoleEntry[]
  networkLog: BrowserNetworkEntry[]
  intercepting: boolean
  interceptPatterns: string[]
  pausedRequests: Map<string, BrowserInterceptedRequest>
  networkRequestMap: Map<string, BrowserNetworkEntry>
}
