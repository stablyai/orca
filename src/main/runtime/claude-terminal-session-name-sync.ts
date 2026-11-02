import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import { parsePaneKey } from '../../shared/stable-pane-id'
import {
  claudeRenameCommand,
  claudeTitleName,
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
  /** The composer's current text, or undefined when it shows none. */
  readComposerDraft: (handle: string) => Promise<string | undefined>
  /** `beforeEachWrite` runs at every write boundary; it throws to stop the command there. */
  sendCommand: (
    handle: string,
    text: string,
    signal: AbortSignal,
    beforeEachWrite: () => Promise<void>
  ) => Promise<void>
  renameTab: (handle: string, name: string) => Promise<void>
  readCustomTitle: (transcriptPath: string) => Promise<string | null>
}

type PendingRename = { name: string; abort: AbortController }

const STALE = 'claude_session_name_sync_stale'
// The user started typing before the paste: wait for the composer again.
const COMPOSER_BUSY = 'claude_composer_busy'
// The user typed into the pasted command: never submit their text with it.
const COMPOSER_CHANGED = 'claude_composer_changed'

// The pane went back to its shell or away, or the rename went stale or met the user's typing.
const EXPECTED_REFUSALS = new Set([
  'agent_not_in_foreground',
  'terminal_handle_stale',
  STALE,
  COMPOSER_BUSY,
  COMPOSER_CHANGED
])

/** Mirrors a terminal tab's name and the Claude Code session name (`/rename`) both ways, on the execution host. */
export class ClaudeTerminalSessionNameSync {
  // The name both sides last agreed on, so neither direction echoes the other.
  private readonly agreed = new Map<string, string>()
  private readonly pendingRenames = new Map<string, PendingRename>()
  // The newest rename per pane, kept while it is written, so an older one still writing is dropped.
  private readonly latestRenames = new Map<string, PendingRename>()
  // A title Claude showed before its transcript recorded it; rechecked at the pane's next turn change.
  private readonly unconfirmedTitles = new Map<string, string>()
  // The name each pane's title last showed; spinner frames of one name share it.
  private readonly lastTitleNames = new Map<string, string>()
  // Bumped on every tab rename, so a confirmation that read the transcript before one is dropped.
  private readonly tabRenameGenerations = new Map<string, number>()

  constructor(private readonly deps: ClaudeTerminalSessionNameSyncDeps) {}

  /** Orca → Claude: the tab was given `title` by the user, a phone or the CLI. */
  tabRenamed(tabId: string, title: string | null): void {
    this.tabRenameGenerations.set(tabId, this.tabRenameGeneration(tabId) + 1)
    const name = normalizeClaudeSessionName(title)
    if (!name) {
      // A cleared title withdraws a rename still waiting for the composer.
      for (const [paneKey, pending] of this.pendingRenames) {
        if (parsePaneKey(paneKey)?.tabId === tabId) {
          pending.abort.abort()
          this.pendingRenames.delete(paneKey)
        }
      }
      for (const paneKey of this.latestRenames.keys()) {
        if (parsePaneKey(paneKey)?.tabId === tabId) {
          this.latestRenames.delete(paneKey)
        }
      }
      return
    }
    if (!this.deps.isEnabled()) {
      return
    }
    const paneKey = this.soleClaudePane(tabId)
    if (paneKey) {
      this.renameSession(paneKey, name)
    }
  }

  /** Claude → Orca: Claude retitled its window; a matching transcript `/rename` names the tab. */
  observeTitle(paneKey: string, title: string): void {
    const shown = claudeTitleName(title)
    if (this.lastTitleNames.get(paneKey) === shown) {
      return
    }
    this.lastTitleNames.set(paneKey, shown)
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

  /** Several Claude panes in one tab: the tab's name belongs to none of them in particular. */
  private soleClaudePane(tabId: string): string | null {
    const paneKeys = new Set(
      this.deps
        .listRows()
        .filter((row) => isTerminalClaudeRow(row) && parsePaneKey(row.paneKey)?.tabId === tabId)
        .map((row) => row.paneKey)
    )
    return paneKeys.size === 1 ? [...paneKeys][0] : null
  }

  /** Rechecked when a delayed rename commits: the setting or the tab's panes may have changed. */
  private canCommit(paneKey: string): boolean {
    const tabId = parsePaneKey(paneKey)?.tabId
    return this.deps.isEnabled() && !!tabId && this.soleClaudePane(tabId) === paneKey
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
    this.latestRenames.set(paneKey, rename)
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
      if (rename.abort.signal.aborted || !this.canCommit(paneKey)) {
        return
      }
      this.agreed.set(paneKey, rename.name)
      // Written now: the writer can stay pending long after, and a later /rename must not wait on it.
      if (this.pendingRenames.get(paneKey) === rename) {
        this.pendingRenames.delete(paneKey)
      }
      await this.deps.sendCommand(
        handle,
        claudeRenameCommand(rename.name),
        rename.abort.signal,
        this.writeCheck(handle, paneKey, rename)
      )
    } catch (error) {
      if (rename.abort.signal.aborted) {
        return
      }
      // Undelivered: the same name must stay retryable.
      if (this.agreed.get(paneKey) === rename.name) {
        this.agreed.delete(paneKey)
      }
      if (describe(error) === COMPOSER_BUSY && this.latestRenames.get(paneKey) === rename) {
        this.renameSession(paneKey, rename.name)
      }
      if (!EXPECTED_REFUSALS.has(describe(error))) {
        console.warn('[claude-session-name] /rename was not delivered:', describe(error))
      }
    }
  }

  private tabRenameGeneration(tabId: string | undefined): number {
    return (tabId && this.tabRenameGenerations.get(tabId)) || 0
  }

  /** Rechecked at each write: the paste needs the newest rename and an empty composer; Enter needs
   *  the composer to hold only the pasted command. The draft is read from the screen just before
   *  each write, which narrows but cannot close the window for a keystroke in between. */
  private writeCheck(handle: string, paneKey: string, rename: PendingRename): () => Promise<void> {
    const command = claudeRenameCommand(rename.name)
    let pasted = false
    return async () => {
      const draft = (await this.deps.readComposerDraft(handle))?.replace(/\s+/g, ' ').trim()
      if (pasted) {
        if (draft && draft !== command) {
          throw new Error(COMPOSER_CHANGED)
        }
        return
      }
      if (this.latestRenames.get(paneKey) !== rename || !this.canCommit(paneKey)) {
        throw new Error(STALE)
      }
      if (draft) {
        throw new Error(COMPOSER_BUSY)
      }
      pasted = true
    }
  }

  private async confirmTitle(paneKey: string, title: string): Promise<void> {
    const tabId = parsePaneKey(paneKey)?.tabId
    const generation = this.tabRenameGeneration(tabId)
    const transcriptPath = this.deps.readTranscriptPath(paneKey)
    if (!transcriptPath) {
      // The hook row may not carry the transcript yet; recheck at the pane's next turn change.
      this.unconfirmedTitles.set(paneKey, title)
      return
    }
    let name: string | null
    try {
      name = await this.deps.readCustomTitle(transcriptPath)
    } catch {
      name = null
    }
    if (
      this.lastTitleNames.get(paneKey) !== claudeTitleName(title) ||
      this.tabRenameGeneration(tabId) !== generation
    ) {
      return
    }
    // Claude also titles its window from auto-generated topics; only a recorded /rename names the tab.
    if (!name || !claudeTitleShowsName(title, name)) {
      // A shown rename can precede its transcript record; recheck at the pane's next turn change.
      this.unconfirmedTitles.set(paneKey, title)
      return
    }
    this.unconfirmedTitles.delete(paneKey)
    if (!this.canCommit(paneKey)) {
      return
    }
    const pending = this.pendingRenames.get(paneKey)
    if (this.agreed.get(paneKey) === name || pending?.name === name) {
      return
    }
    // A /rename typed in Claude is newer than a tab rename still waiting for the composer.
    pending?.abort.abort()
    this.pendingRenames.delete(paneKey)
    this.latestRenames.delete(paneKey)
    const handle = this.deps.getHandle(paneKey)
    if (!handle) {
      return
    }
    this.agreed.set(paneKey, name)
    try {
      await this.deps.renameTab(handle, name)
    } catch (error) {
      // Not renamed: keep the name retryable at the pane's next turn change.
      if (this.agreed.get(paneKey) === name) {
        this.agreed.delete(paneKey)
      }
      this.unconfirmedTitles.set(paneKey, title)
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
