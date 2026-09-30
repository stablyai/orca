import { sweepProcessIdentities, type ProcessIdentityRow } from '../opencode/opencode-client-sweep'
import { buildParentPidIndex, findOwningPane } from '../agent-hooks/pane-process-ancestry'
import type { PtyRegistration } from '../memory/pty-registry'
import type { CodexDaemonHookPane } from '../../shared/agent-hook-listener/codex-shared-daemon-attribution'

/**
 * Which local panes run a live Codex client, so posts from Codex's shared
 * app-server daemon are only ever re-owned by a pane that runs Codex, never
 * by a shell or dev-server split in the same worktree.
 */

const SWEEP_REUSE_MS = 1_000
// Why well under the hook's curl timeout: a slow sweep must degrade to "unknown", not lose the post.
const SWEEP_WAIT_MS = 1_500

function baseName(value: string): string {
  return (value.split(/[\\/]/).at(-1) ?? '').toLowerCase().replace(/\.exe$/, '')
}

/** A Codex TUI/CLI (native binary or its npm launcher), not the shared app-server daemon. */
export function isCodexClientProcess(row: {
  executable: string
  argv: readonly string[]
}): boolean {
  const names = [row.executable, row.argv[0] ?? '', row.argv[1] ?? ''].map(baseName)
  // Why the triple prefix: older npm builds ship `codex-<triple>`, and Linux `comm` truncates it.
  const isCodex = names.some(
    (name) =>
      name === 'codex' || name === 'codex.js' || /^codex-(?:x86_64|aarch64|arm64)/.test(name)
  )
  return isCodex && !row.argv.includes('app-server')
}

/** Registered PTYs as attribution panes, flagged when a Codex client runs beneath their shell. */
export function listCodexDaemonHookPanes(
  ptys: readonly PtyRegistration[],
  processes: readonly ProcessIdentityRow[] | null
): CodexDaemonHookPane[] {
  const paneKeyByShellPid = new Map<number, string>()
  for (const pty of ptys) {
    if (pty.paneKey && pty.pid !== null && !paneKeyByShellPid.has(pty.pid)) {
      paneKeyByShellPid.set(pty.pid, pty.paneKey)
    }
  }
  const codexPaneKeys = new Set<string>()
  if (processes) {
    const ppidByPid = buildParentPidIndex(processes)
    for (const row of processes) {
      if (!isCodexClientProcess(row)) {
        continue
      }
      const paneKey = findOwningPane(ppidByPid, paneKeyByShellPid, row.pid)
      if (paneKey) {
        codexPaneKeys.add(paneKey)
      }
    }
  }
  return ptys.map((pty) => ({
    paneKey: pty.paneKey,
    worktreeId: pty.worktreeId,
    runsCodexClient: pty.paneKey !== null && codexPaneKeys.has(pty.paneKey)
  }))
}

/**
 * Host process table for daemon-post attribution, shared by posts landing
 * within a second of each other (a tool call fires several hooks back to
 * back). Resolves null when the sweep is slow or fails.
 */
export class CodexClientProcessSnapshot {
  private latest: { atMs: number; rows: Promise<ProcessIdentityRow[] | null> } | null = null

  constructor(
    private readonly sweep: () => Promise<ProcessIdentityRow[]> = () => sweepProcessIdentities(),
    private readonly now: () => number = () => Date.now()
  ) {}

  read(): Promise<ProcessIdentityRow[] | null> {
    const nowMs = this.now()
    if (this.latest && nowMs - this.latest.atMs < SWEEP_REUSE_MS) {
      return this.latest.rows
    }
    const rows = new Promise<ProcessIdentityRow[] | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), SWEEP_WAIT_MS)
      timer.unref?.()
      this.sweep().then(
        (swept) => {
          clearTimeout(timer)
          resolve(swept)
        },
        () => {
          clearTimeout(timer)
          resolve(null)
        }
      )
    })
    this.latest = { atMs: nowMs, rows }
    return rows
  }
}
