import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { parsePaneKey } from '../../shared/stable-pane-id'
import {
  claudeRenameCommand,
  claudeTitleShowsName,
  normalizeClaudeSessionName
} from '../claude/claude-terminal-session-name'

type Row = Pick<
  AgentStatusIpcPayload,
  'paneKey' | 'agentType' | 'structuredHost' | 'providerSessionOnly'
>

export type ClaudeTerminalSessionNameSyncDeps = {
  isEnabled: () => boolean
  listRows: () => readonly Row[]
  /** The pane's Claude transcript, from its newest hook-reported provider session. */
  readTranscriptPath: (paneKey: string) => string | null
  getHandle: (paneKey: string) => string | null
  /** Resolves true once the composer is at rest and empty; false when the wait gave up. */
  waitForEmptyComposer: (handle: string, signal: AbortSignal) => Promise<boolean>
  sendCommand: (handle: string, text: string, signal: AbortSignal) => Promise<void>
  renameTab: (handle: string, name: string) => Promise<void>
  readCustomTitle: (transcriptPath: string) => Promise<string | null>
}

type PendingRename = { name: string; abort: AbortController }

// The pane went back to its shell or away; its hook row outlived the agent.
const EXPECTED_REFUSALS = new Set(['agent_not_in_foreground', 'terminal_handle_stale'])

/** Mirrors a terminal tab's name and the Claude Code session name (`/rename`) both ways, on the execution host. */
export class ClaudeTerminalSessionNameSync {
  // The name both sides last agreed on, so neither direction echoes the other.
  private readonly agreed = new Map<string, string>()
  private readonly pendingRenames = new Map<string, PendingRename>()
  // A title Claude showed before its transcript recorded it; rechecked at the pane's next turn change.
  private readonly unconfirmedTitles = new Map<string, string>()
  private readonly lastTitles = new Map<string, string>()

  constructor(private readonly deps: ClaudeTerminalSessionNameSyncDeps) {}

  /** Orca → Claude: the tab was given `title` by the user, a phone or the CLI. */
  tabRenamed(tabId: string, title: string | null): void {
    const name = normalizeClaudeSessionName(title)
    if (!name || !this.deps.isEnabled()) {
      return
    }
    const panes = this.deps
      .listRows()
      .filter((row) => isTerminalClaudeRow(row) && parsePaneKey(row.paneKey)?.tabId === tabId)
    const paneKeys = [...new Set(panes.map((row) => row.paneKey))]
    // Several Claude panes in one tab: the tab's name belongs to none of them in particular.
    if (paneKeys.length !== 1) {
      return
    }
    this.renameSession(paneKeys[0], name)
  }

  /** Claude → Orca: Claude retitled its window; a matching transcript `/rename` names the tab. */
  observeTitle(paneKey: string, title: string): void {
    if (this.lastTitles.get(paneKey) === title) {
      return
    }
    this.lastTitles.set(paneKey, title)
    if (this.deps.isEnabled()) {
      void this.confirmTitle(paneKey, title)
    }
  }

  /** A turn boundary may come with the transcript a just-renamed session had not written yet. */
  observeTurnChange(paneKey: string): void {
    const title = this.unconfirmedTitles.get(paneKey)
    if (title !== undefined && this.deps.isEnabled()) {
      void this.confirmTitle(paneKey, title)
    }
  }

  private renameSession(paneKey: string, name: string): void {
    const pending = this.pendingRenames.get(paneKey)
    if (pending?.name === name || (!pending && this.agreed.get(paneKey) === name)) {
      return
    }
    // The newest name wins; an older one still waiting for the composer is dropped.
    pending?.abort.abort()
    const abort = new AbortController()
    const rename = { name, abort }
    this.pendingRenames.set(paneKey, rename)
    void this.deliver(paneKey, rename).finally(() => {
      if (this.pendingRenames.get(paneKey) === rename) {
        this.pendingRenames.delete(paneKey)
      }
    })
  }

  private async deliver(paneKey: string, rename: PendingRename): Promise<void> {
    const handle = this.deps.getHandle(paneKey)
    if (!handle) {
      return
    }
    try {
      if (!(await this.deps.waitForEmptyComposer(handle, rename.abort.signal))) {
        return
      }
      if (rename.abort.signal.aborted) {
        return
      }
      this.agreed.set(paneKey, rename.name)
      // Written now: the writer can stay pending long after, and a later /rename must not wait on it.
      if (this.pendingRenames.get(paneKey) === rename) {
        this.pendingRenames.delete(paneKey)
      }
      await this.deps.sendCommand(handle, claudeRenameCommand(rename.name), rename.abort.signal)
    } catch (error) {
      if (!rename.abort.signal.aborted && !EXPECTED_REFUSALS.has(describe(error))) {
        console.warn('[claude-session-name] /rename was not delivered:', describe(error))
      }
    }
  }

  private async confirmTitle(paneKey: string, title: string): Promise<void> {
    const transcriptPath = this.deps.readTranscriptPath(paneKey)
    if (!transcriptPath) {
      return
    }
    let name: string | null
    try {
      name = await this.deps.readCustomTitle(transcriptPath)
    } catch {
      name = null
    }
    if (this.lastTitles.get(paneKey) !== title) {
      return
    }
    if (!name) {
      // A fresh session may hold its rename in memory until its first turn writes the transcript.
      this.unconfirmedTitles.set(paneKey, title)
      return
    }
    this.unconfirmedTitles.delete(paneKey)
    // Claude also titles its window from auto-generated topics; only a recorded /rename names the tab.
    if (!claudeTitleShowsName(title, name)) {
      return
    }
    const pending = this.pendingRenames.get(paneKey)
    if (this.agreed.get(paneKey) === name || pending?.name === name) {
      return
    }
    // A /rename typed in Claude is newer than a tab rename still waiting for the composer.
    pending?.abort.abort()
    this.pendingRenames.delete(paneKey)
    const handle = this.deps.getHandle(paneKey)
    if (!handle) {
      return
    }
    this.agreed.set(paneKey, name)
    try {
      await this.deps.renameTab(handle, name)
    } catch (error) {
      console.warn('[claude-session-name] the tab was not renamed:', describe(error))
    }
  }
}

function isTerminalClaudeRow(row: Row): boolean {
  return row.agentType === 'claude' && !row.structuredHost && !row.providerSessionOnly
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
