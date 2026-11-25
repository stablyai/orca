import type { RemoteServerSelection } from '../hosts/remote-server-selection'

export type CliErrorContext = {
  commandPath?: readonly string[]
  /** The `--worktree` value this invocation sent; the runtime's error never echoes it. */
  worktreeSelector?: string
  /** The runtime error omits the original --repo selector. */
  repoSelector?: string
  /** True when --environment, --pairing-code, --host runtime:, or their env vars chose a server. */
  remoteServerSelected?: boolean
  /** How --environment, --pairing-code, --host runtime: or their env vars named that server. */
  remoteServer?: RemoteServerSelection
  /** Concise orchestration failures: compact JSON plus one `error: <code>: <message>` stderr line. */
  conciseOrchestration?: boolean
}
