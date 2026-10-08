import { createHash } from 'node:crypto'

import { startsNewAgentRun } from '../../../shared/agent-hook-listener/provider-event-routing'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import type { AgentHookSource } from '../../../shared/agent-hook-relay'
import {
  CLOSED_AGENT_STATUS_PANE_KEYS_MAX,
  CLOSED_AGENT_STATUS_TAB_IDS_MAX,
  RETIRED_PANE_FENCES_MAX
} from './server-constants'
import type { RetiredPaneAlias, RetiredPaneFence } from './server-types'
import { AgentHookServerStatusInference } from './server-status-inference'

export abstract class AgentHookServerStatusDisposition extends AgentHookServerStatusInference {
  protected markTabClosedForAgentStatus(tabId: string): void {
    // Delete-then-add keeps recently closed tabs most-recent so eviction sheds only the oldest ids.
    this.closedAgentStatusTabIds.delete(tabId)
    this.closedAgentStatusTabIds.add(tabId)
    for (const key of this.state.lastStatusByPaneKey.keys()) {
      if (
        (parsePaneKey(key)?.tabId ?? parseLegacyNumericPaneKey(key)?.tabId) === tabId &&
        !this.retiredPaneFencesByKey.has(key)
      ) {
        this.recordRetiredPaneFence(new Set([key]), [])
      }
    }
    for (const [key, fence] of this.retiredPaneFencesByKey) {
      const ownerTabId = parsePaneKey(key)?.tabId ?? parseLegacyNumericPaneKey(key)?.tabId
      if (ownerTabId === tabId) {
        fence.retirementIdsByPaneKey = {}
        fence.closed = true
      }
    }
    while (this.closedAgentStatusTabIds.size > CLOSED_AGENT_STATUS_TAB_IDS_MAX) {
      const oldest = this.closedAgentStatusTabIds.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.closedAgentStatusTabIds.delete(oldest)
    }
  }

  protected getAgentStatusDisposition(
    paneKey: string,
    event?: {
      source?: AgentHookSource
      /** Raw wire value, so the gate can tell "field absent" from "field present but unknown". */
      rawSource?: unknown
      hookEventName?: string
      isReplay?: boolean
      hasExplicitPrompt?: boolean
      launchToken?: string
      /** Host/workspace provenance matched internally to a retained authority commitment. */
      retainedLaunchTokenHash?: string
      /** A process-lifetime Working: a fresh command whose foreground argv proves a new agent run. */
      processNewTurn?: boolean
    }
  ): 'accept' | 'restart' | 'suppress' {
    const ownerPaneKey = this.resolvePaneKeyAlias(paneKey)
    const paneRetired =
      this.closedAgentStatusPaneKeys.has(paneKey) ||
      this.closedAgentStatusPaneKeys.has(ownerPaneKey)
    const tabId =
      parsePaneKey(ownerPaneKey)?.tabId ?? parseLegacyNumericPaneKey(ownerPaneKey)?.tabId
    if (
      (tabId && this.closedAgentStatusTabIds.has(tabId)) ||
      this.retiredPaneFencesByKey.get(ownerPaneKey)?.closed
    ) {
      return 'suppress'
    }
    const retirementFence = this.retiredPaneFencesByKey.get(ownerPaneKey)
    if (
      paneRetired &&
      event?.source === 'omp' &&
      retirementFence?.aliases.some(
        ({ physicalPaneKey, entry }) =>
          this.retiredPaneFencesByKey.get(physicalPaneKey) !== retirementFence ||
          this.retiredPaneFencesByKey.get(entry.stablePaneKey) !== retirementFence
      )
    ) {
      return 'suppress'
    }
    if (!paneRetired) {
      const tokenFence = this.restartedStatusLaunchTokenHashByPaneKey.get(ownerPaneKey)
      // Why: deferred retirement lets a new process start in a still-authorized pane, so
      // its tokened SessionStart re-fences; prompts recur, so a stale process would win.
      if (
        event?.hookEventName === 'SessionStart' &&
        event.isReplay !== true &&
        tokenFence !== undefined
      ) {
        const startedLaunchToken = event.launchToken?.trim()
        if (startedLaunchToken) {
          this.restartedStatusLaunchTokenHashByPaneKey.set(ownerPaneKey, {
            hash: createHash('sha256').update(startedLaunchToken).digest('hex')
          })
          return 'accept'
        }
      }
      if (event && event.processNewTurn !== true && tokenFence) {
        const launchToken = event.launchToken?.trim()
        const tokenHash =
          event.retainedLaunchTokenHash ??
          (launchToken ? createHash('sha256').update(launchToken).digest('hex') : undefined)
        if (tokenHash !== tokenFence.hash) {
          return 'suppress'
        }
      }
      return 'accept'
    }
    // Why: command completion retires launch authority but leaves its shell pane reusable.
    // A live new-turn event proves a new agent process owns the retired pane just like a
    // fresh prompt does — without it, a session resumed in a reused pane stays rowless (STA-3386).
    // Why the classifier, not literals: only 5 of 18 sources name their boundary
    // `UserPromptSubmit`/`SessionStart`; the rest stayed retired forever.
    const startsNewRun =
      event !== undefined &&
      startsNewAgentRun({
        source: event.source,
        rawSource: event.rawSource,
        hookEventName: event.hookEventName,
        hasExplicitPrompt: event.hasExplicitPrompt
      })
    // Why the token is minted here: a revive proves a live lifecycle, and fencing follow-up
    // status on that launch token stops a stale process reclaiming the pane's row without
    // restoring retired orchestration authority.
    if ((startsNewRun || event?.processNewTurn === true) && event?.isReplay !== true) {
      this.closedAgentStatusPaneKeys.delete(paneKey)
      this.closedAgentStatusPaneKeys.delete(ownerPaneKey)
      const launchToken = event?.launchToken?.trim()
      if (launchToken) {
        this.restartedStatusLaunchTokenHashByPaneKey.set(ownerPaneKey, {
          hash: createHash('sha256').update(launchToken).digest('hex')
        })
      } else {
        this.restartedStatusLaunchTokenHashByPaneKey.delete(ownerPaneKey)
      }
      return 'restart'
    }
    return 'suppress'
  }

  // Why: a fence can span tabs (a pane detached into another tab), and legacy numeric
  // keys never parse as stable ones — resolve both forms so neither slips the tab check.
  protected isClosedAgentStatusTabForPaneKey(paneKey: string): boolean {
    const tabId =
      parsePaneKey(paneKey)?.tabId ?? parseLegacyNumericPaneKey(paneKey)?.tabId ?? undefined
    return tabId !== undefined && this.closedAgentStatusTabIds.has(tabId)
  }

  protected takeRetiredPaneRestartId(paneKey: string): string | undefined {
    const fence = this.retiredPaneFencesByKey.get(paneKey)
    const id = fence?.retirementIdsByPaneKey[paneKey]
    if (fence) {
      fence.retirementIdsByPaneKey = {}
    }
    return id
  }

  protected recordRetiredPaneFence(
    paneKeys: ReadonlySet<string>,
    aliases: readonly RetiredPaneAlias[],
    retirementId?: string
  ): void {
    const closed = [...paneKeys].some(
      (key) =>
        this.retiredPaneFencesByKey.get(key)?.closed || this.isClosedAgentStatusTabForPaneKey(key)
    )
    const retirementIdsByPaneKey: Record<string, string> = {}
    for (const key of paneKeys) {
      const id = closed ? undefined : retirementId
      if (id) {
        retirementIdsByPaneKey[key] = id
      }
    }
    const fence: RetiredPaneFence = {
      paneKeys: [...paneKeys],
      aliases,
      retirementIdsByPaneKey,
      ...(closed ? { closed: true as const } : {})
    }
    for (const key of paneKeys) {
      // Delete-then-set keeps the newest fence most-recent so eviction sheds only the oldest.
      this.retiredPaneFencesByKey.delete(key)
      this.retiredPaneFencesByKey.set(key, fence)
    }
    while (this.retiredPaneFencesByKey.size > RETIRED_PANE_FENCES_MAX) {
      const oldest = this.retiredPaneFencesByKey.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.retiredPaneFencesByKey.delete(oldest)
    }
  }

  protected markPaneClosedForAgentStatus(paneKey: string): void {
    this.closedAgentStatusPaneKeys.delete(paneKey)
    this.closedAgentStatusPaneKeys.add(paneKey)
    while (this.closedAgentStatusPaneKeys.size > CLOSED_AGENT_STATUS_PANE_KEYS_MAX) {
      const oldest = this.closedAgentStatusPaneKeys.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.closedAgentStatusPaneKeys.delete(oldest)
    }
  }
}
