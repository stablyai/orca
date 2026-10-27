import { prepareJcodeRootSettlement } from '../../../shared/agent-hook-listener/jcode-hook-preparation'
import {
  getJcodeTerminalTitleActivity,
  getJcodeTerminalTitleStatus
} from '../../../shared/jcode-terminal-title'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { AgentHookServerRowOwnership } from './server-row-ownership'
import { isValidPaneKey } from './server-status-identity'
import { PaneTimers } from './program-status/pane-timers'
import { JcodeSubagentExpiryTimers } from '../../../shared/jcode-subagent-expiry-timers'

const JCODE_TITLE_SETTLE_GRACE_MS = 2_000

type JcodeTitleCandidate = Pick<
  AgentHookEventPayload,
  'launchToken' | 'terminalHandle' | 'worktreeId' | 'tabId'
> & {
  sessionId: string
  revision: number
  generation: number
  firstLastAt: number | null
}

export abstract class AgentHookServerJcodeTitleSettle extends AgentHookServerRowOwnership {
  private readonly jcodeTitleCandidates = new Map<string, JcodeTitleCandidate>()
  private readonly jcodeTitleTimers = new PaneTimers()
  private readonly jcodeSubagentExpiry = new JcodeSubagentExpiryTimers(this.state)

  protected clearJcodeTitleInference(): void {
    this.jcodeTitleTimers.clear()
    this.jcodeTitleCandidates.clear()
    this.jcodeSubagentExpiry.clearAll()
  }

  private resetJcodeTitle(paneKey: string): void {
    this.jcodeTitleTimers.cancel(paneKey)
    this.jcodeTitleCandidates.delete(paneKey)
  }

  private eligibleJcodeRoot(paneKey: string) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Main's admitted rows carry server enrichment in the shared listener map.
    const row = this.state.lastStatusByPaneKey.get(paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    const turn = this.state.jcodeTurnByPaneKey.get(paneKey)
    if (
      !this.statusHooksEnabled ||
      !row ||
      row.connectionId ||
      row.isReplay ||
      row.restoredUnconfirmed ||
      row.providerSessionOnly ||
      row.retainedForLiveness ||
      row.toolAgentId ||
      row.source !== 'jcode' ||
      row.payload.agentType !== 'jcode' ||
      (row.payload.mainAgent?.state ?? row.payload.state) !== 'working' ||
      !turn?.active ||
      row.providerSession?.key !== 'session_id' ||
      row.providerSession.id !== turn.sessionId
    ) {
      return null
    }
    // Only this pane's attributed root turn qualifies; titles never supply session identity.
    return { row, turn }
  }

  private currentJcodeTitleCandidate(paneKey: string) {
    const candidate = this.jcodeTitleCandidates.get(paneKey)
    const root = this.eligibleJcodeRoot(paneKey)
    return candidate &&
      root &&
      candidate.generation === this.statusHookGeneration &&
      candidate.sessionId === root.turn.sessionId &&
      candidate.revision === root.turn.revision &&
      candidate.launchToken === root.row.launchToken &&
      candidate.terminalHandle === root.row.terminalHandle &&
      candidate.worktreeId === root.row.worktreeId &&
      candidate.tabId === root.row.tabId
      ? { candidate, ...root }
      : null
  }

  observeJcodeTerminalTitle(paneKey: string, title: string | null): void {
    const root = isValidPaneKey(paneKey) ? this.eligibleJcodeRoot(paneKey) : null
    const status = title === null ? null : getJcodeTerminalTitleStatus(title)
    if (!root || !status) {
      this.resetJcodeTitle(paneKey)
      return
    }
    if (status === 'working') {
      this.resetJcodeTitle(paneKey)
      this.jcodeTitleCandidates.set(paneKey, {
        sessionId: root.turn.sessionId,
        revision: root.turn.revision,
        generation: this.statusHookGeneration,
        launchToken: root.row.launchToken,
        terminalHandle: root.row.terminalHandle,
        worktreeId: root.row.worktreeId,
        tabId: root.row.tabId,
        firstLastAt: null
      })
      return
    }
    const current = this.currentJcodeTitleCandidate(paneKey)
    // The parser also returns idle for an identity-only title; only a native last field ends work.
    if (!current || title === null || getJcodeTerminalTitleActivity(title) !== 'last') {
      this.resetJcodeTitle(paneKey)
      return
    }
    if (current.candidate.firstLastAt === null) {
      current.candidate.firstLastAt = Date.now()
      this.jcodeTitleTimers.defer(paneKey, JCODE_TITLE_SETTLE_GRACE_MS, (key) => {
        this.settleJcodeTitle(key)
      })
    }
  }

  private settleJcodeTitle(paneKey: string): void {
    const current = this.currentJcodeTitleCandidate(paneKey)
    this.resetJcodeTitle(paneKey)
    if (!current || !this.canWriteLegacyStatusRow(current.row)) {
      return
    }
    const prepared = prepareJcodeRootSettlement(
      this.state,
      paneKey,
      current.candidate.sessionId,
      current.candidate.revision
    )
    if (prepared) {
      const row = current.row
      this.applyNormalizedStatus(
        {
          paneKey,
          tabId: row.tabId,
          worktreeId: row.worktreeId,
          connectionId: row.connectionId,
          providerSession: row.providerSession,
          launchToken: row.launchToken,
          terminalHandle: row.terminalHandle,
          hostTurnRevision: row.hostTurnRevision,
          source: row.source,
          payload: prepared.payload
        },
        undefined,
        'hook',
        undefined,
        undefined,
        false,
        prepared.commit
      )
    }
  }

  protected override commitStatusRowMutation(
    before: EnrichedAgentHookEventPayload | null | undefined,
    after: EnrichedAgentHookEventPayload | null | undefined,
    emit = true
  ): boolean {
    if (after) {
      this.jcodeSubagentExpiry.arm(after.paneKey, (row) => {
        if (this.server && this.statusHooksEnabled) {
          this.applyNormalizedStatus(row)
        }
      })
    }
    if (before && before.paneKey !== after?.paneKey) {
      this.resetJcodeTitle(before.paneKey)
      if (after) {
        this.resetJcodeTitle(after.paneKey)
      }
    } else if (after && !this.currentJcodeTitleCandidate(after.paneKey)) {
      this.resetJcodeTitle(after.paneKey)
    }
    return super.commitStatusRowMutation(before, after, emit)
  }
}
