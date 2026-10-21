import {
  readWorkspaceRecord,
  writeWorkspaceRecord,
  type WorkspaceRecordStore
} from './sort-stamp-records'
import type { AgentPaneWorkspace } from '../../agent-hooks/agent-transition-detector'

/** At most one write per workspace per minute; cleanup judges idleness in days. */
export const TERMINAL_USE_THROTTLE_MS = 60_000

type TerminalUseRecord = { lastTerminalUseAt?: number }

export type TerminalUseStore = WorkspaceRecordStore<
  TerminalUseRecord,
  { lastTerminalUseAt: number }
>

export type TerminalUseSources = {
  store: () => TerminalUseStore | null
  /** The workspace a PTY belongs to on this host, or null when this host does not know it. */
  workspaceOfPty: (ptyId: string) => AgentPaneWorkspace | null
  isWriteFenced: (worktreeId: string) => boolean
}

/**
 * Writes when a workspace's terminal was last used, on the host that owns it, for every device:
 * input from the window, a phone or the CLI, and a phone attaching. Output never counts.
 */
export class TerminalUseProducer {
  private readonly writtenAt = new Map<string, number>()

  constructor(private readonly sources: TerminalUseSources) {}

  noteTerminalUse(ptyId: string, now: number): void {
    const workspace = this.sources.workspaceOfPty(ptyId)
    if (!workspace) {
      return
    }
    const key = `${workspace.sshHostId ?? ''}|${workspace.worktreeId}`
    const last = this.writtenAt.get(key)
    if (last !== undefined && now - last < TERMINAL_USE_THROTTLE_MS) {
      return
    }
    // Throttled even when nothing is written, so a fenced or recordless workspace stays cheap.
    this.writtenAt.set(key, now)
    // A WSL move only takes this machine's projects.
    if (!workspace.sshHostId && this.sources.isWriteFenced(workspace.worktreeId)) {
      return
    }
    const store = this.sources.store()
    // Only a workspace with a record is written; writing would create one for a stale id.
    if (readWorkspaceRecord(store, workspace)) {
      writeWorkspaceRecord(store, workspace, { lastTerminalUseAt: now })
    }
  }
}
