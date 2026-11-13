import type { ChildProcess } from 'node:child_process'
import type { CdpWsProxy } from '../../cdp/transport/cdp-ws-proxy'

export type SessionState = {
  proxy: CdpWsProxy
  cdpEndpoint: string
  initialized: boolean
  consecutiveTimeouts: number
  // Restore these routes after a session restart.
  activeInterceptPatterns: string[]
  activeCapture: boolean
  // Detect idle daemon retirement from the gap between commands.
  lastCommandAt: number
  // Revalidate after queue delay, when the tab may have disappeared.
  webContentsId: number
  activeProcess: ChildProcess | null
  // agent-browser keeps the `snapshot --delta` baseline in this session's daemon.
  hasDeltaBaseline?: boolean
}
