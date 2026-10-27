import type { TerminalLaunchResult } from '../../shared/agent-session-resume'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { TuiAgent } from '../../shared/tui-agent'
import type { AgentSessionClaimedSpawnResult } from '../../shared/agent-session-host-authority'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { TerminalOwner } from '../../shared/terminal-owner'
import type { OpenCodeCliCapabilities } from '../../shared/opencode-cli-version'

export type PtySpawnResult = TerminalLaunchResult & {
  /** Execution-host probe; absent on older hosts and reattachments. */
  openCodeCapabilities?: OpenCodeCliCapabilities
  agentSessionEnsure?: AgentSessionClaimedSpawnResult
  /** App-routable id; remote relay-local handles cannot route renderer/runtime IPC. */
  id: string
  /** Opaque provider-owned identity for this process behind a reusable PTY id. */
  incarnationId?: PtyIncarnationId
  /** The provider observed this exact spawn exit before returning its spawn result. */
  exitedBeforeSpawnReply?: true
  /** Host marker proof: false means inspected/unarmed; absent means legacy and retains the client guess. */
  shellReadyArmed?: boolean
  /** OS shell PID for subtree memory collection; null when the host cannot publish one during spawn. */
  pid?: number | null
  /** Minimal allowlisted launch ownership returned by daemon reattach. */
  launchAgent?: TuiAgent
  /** Local WSL context: null is native; undefined is unavailable/legacy. */
  wslDistro?: string | null
  /** Daemon reattach ANSI screen restore for xterm. */
  snapshot?: string
  /** Restore xterm size before snapshot replay so cursor coordinates match. */
  snapshotCols?: number
  snapshotRows?: number
  /** Normal-buffer history and mode preamble before an alternate-screen frame. */
  snapshotPrefixAnsi?: string
  /** Visual alternate-screen frame, separate so newer clients can omit it safely. */
  snapshotFrameAnsi?: string
  /** Live state to append when omitting `snapshotFrameAnsi`. */
  snapshotFrameRestoreAnsi?: string
  /** Attach sequence domain: reset begins a new provider generation; continued retains the absolute domain. */
  providerSequence?: {
    value: number
    generation: 'continued' | 'reset'
  }
  /** Snapshot kitty flags seed hidden runtime query replies; renderers reassert after replay screen switches. */
  snapshotKittyKeyboardFlags?: number
  /** Main-reconciled renderer sequence for the flags attach boundary; providers cannot set this. */
  snapshotSeq?: number
  /** Ordered ownership evidence proven by the provider snapshot. */
  snapshotTerminalOwner?: TerminalOwner
  /** Fresh-spawn cwd provenance only; in-process and never sent over the wire. */
  startupCwdSource?: 'request' | 'recovered-history'
  isReattach?: boolean
  /** Measured post-attach grid only; daemon/relay leave size unchanged and must not echo requested dimensions. */
  attachedGrid?: { cols: number; rows: number }
  /** Daemon OSC title seeds main records after relaunch; never replay as terminal bytes. */
  lastTitle?: string
  isAlternateScreen?: boolean
  /** Incremental relay replay; unlike snapshot, must not clear the terminal before writing. */
  replay?: string
  /** Requested session expired before reattach; renderer reports that a new shell started. */
  sessionExpired?: boolean
  /** Crash-history restore: spawn in saved cwd and replay scrollback as read-only history. */
  coldRestore?: {
    scrollback: string
    cwd: string
    /** Optional for compatibility with restore payloads from older app code. */
    cols?: number
    rows?: number
    oscLinks?: TerminalOscLinkRange[]
    /** Last OSC title from the recovered checkpoint (see `lastTitle` above). */
    lastTitle?: string
  }
}
