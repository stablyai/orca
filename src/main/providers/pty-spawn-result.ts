import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { TuiAgent } from '../../shared/types'

export type PtySpawnResult = {
  /** App-facing PTY id. Remote providers must return globally routable ids,
   *  not relay-local handles, because renderer/runtime IPC routes by this key. */
  id: string
  /** OS-level pid of the shell process, when available at spawn time.
   *  Why: the memory collector needs this to walk each PTY's process
   *  subtree. Daemon-backed providers return it from the RPC result;
   *  local providers read it from node-pty. Null when the underlying
   *  provider could not publish a pid (e.g., race during spawn). */
  pid?: number | null
  /** Minimal allowlisted launch ownership returned by daemon reattach. */
  launchAgent?: TuiAgent
  /** Local WSL context: null is native; undefined is unavailable/legacy. */
  wslDistro?: string | null
  /** ANSI snapshot of the terminal screen, present when reattaching to an
   *  existing daemon session. Write this to xterm.js to restore visual state. */
  snapshot?: string
  /** Dimensions the snapshot was captured at. Resize xterm.js to these before
   *  writing the snapshot so ANSI cursor positions land correctly. */
  snapshotCols?: number
  snapshotRows?: number
  /** Provider sequence at the attach boundary. `reset` starts a new provider
   *  generation; `continued` resumes the existing absolute domain. */
  providerSequence?: {
    value: number
    generation: 'continued' | 'reset'
  }
  /** Kitty keyboard flags persisted in the daemon snapshot, threaded so the
   *  re-seeded runtime emulator answers hidden `CSI ? u` with the real flags
   *  (terminal-query-authority.md §kitty). Never replayed into a renderer
   *  xterm — POST_REPLAY_REATTACH_RESET's kitty reset stays authoritative. */
  snapshotKittyKeyboardFlags?: number
  /** True when the spawn reattached to an existing daemon session. */
  isReattach?: boolean
  /** True when the reattached session uses the alternate screen buffer
   *  (e.g., Codex CLI, vim). Normal-screen TUIs like Claude Code are false. */
  isAlternateScreen?: boolean
  /** Buffered output returned by relay pty.attach. Unlike snapshot, this is
   *  incremental scrollback and must not clear the terminal before replay. */
  replay?: string
  /** True when the caller requested reattach (sessionId was provided) but the
   *  relay PTY was gone (grace window elapsed). The renderer uses this to show
   *  a brief "Session expired — new shell started" message. */
  sessionExpired?: boolean
  /** Present when cold-restoring from disk history after a daemon crash.
   *  Contains the saved scrollback and CWD. The new shell spawns in the
   *  saved CWD; the scrollback is written to xterm.js as read-only history. */
  coldRestore?: {
    scrollback: string
    cwd: string
    /** Optional for compatibility with restore payloads from older app code. */
    cols?: number
    rows?: number
    oscLinks?: TerminalOscLinkRange[]
  }
}
