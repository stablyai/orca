import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  getAgentSessionOptionCatalog,
  type AgentSessionOptionCatalog,
  type CatalogCommandDelivery,
  type CatalogModel
} from '../../../src/shared/agent-session-option-catalog'
import type { RpcClient } from '../transport/rpc-client'
import { useDiscoveredAgentCatalogModels } from './mobile-agent-model-discovery'
import {
  getAppliedReportModelId,
  getScopedRecord,
  setAppliedReportModelId
} from './mobile-native-chat-session-option-records'
import type {
  SessionOptionDescriptor,
  SessionOptionValue
} from '../../../src/shared/native-chat-session-options'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import {
  buildNativeChatSessionOptionCommand,
  recordNativeChatSessionOptionCommand
} from '../../../src/shared/native-chat-session-option-commands'
import {
  buildNativeChatSessionOptionSnapshot,
  withTrackedNativeChatModel
} from '../../../src/shared/native-chat-session-option-snapshot'
import {
  applyNativeChatReportedSessionOptions,
  clearNativeChatSessionModel,
  getTrackedSessionOption,
  isFlipOnlyMidSession,
  matchNativeChatCatalogModelId,
  setTrackedSessionOption,
  type NativeChatSessionOptionRecord
} from '../../../src/shared/native-chat-session-option-state'

export type MobileNativeChatSessionOptionsController = {
  /** Model descriptor first, then the current model's options; empty when the
   *  agent has no catalog. */
  snapshot: SessionOptionDescriptor[]
  /** Descriptor id with a dispatch in flight; the UI disables rows meanwhile. */
  pendingId: string | null
  setOption: (id: string, value: SessionOptionValue) => Promise<boolean>
  invokeAction: (id: string) => Promise<boolean>
  /** Track a slash command the user typed themselves (e.g. `/model sonnet`). */
  recordCommand: (command: string) => void
}

type PendingOperation = { id: string; token: number }

export { clearMobileSessionOptionRecordsForTests } from './mobile-native-chat-session-option-records'

const EMPTY_SNAPSHOT: SessionOptionDescriptor[] = []

/** The model list every consumer must see: the host's live list when a probe
 *  returned one (desktop replaces the seed identically), plus the tracked model
 *  when that list no longer names it. */
function activeModels(
  catalog: AgentSessionOptionCatalog,
  record: NativeChatSessionOptionRecord,
  discovered: CatalogModel[] | null
): CatalogModel[] {
  return withTrackedNativeChatModel(catalog, discovered ?? catalog.models, record)
}

export function useMobileNativeChatSessionOptions(args: {
  agent: string | null
  /** Stable per-tab scope (host + worktree + tab), or null when no tab is active. */
  scopeKey: string | null
  /** Provider model from live agent status, when the hook reported one. */
  reportedModel: string | null
  /** Null until the host connection is up; model discovery waits for it. */
  client: RpcClient | null
  hostId: string
  worktreeId: string
  dispatchCommand: (
    command: string,
    options?: { delivery?: CatalogCommandDelivery }
  ) => Promise<MobileNativeChatSendOutcome>
  /** A model change that must happen in the agent's own TUI picker was
   *  dispatched — bring the terminal view forward. */
  onAgentPicker?: () => void
}): MobileNativeChatSessionOptionsController {
  const { agent, scopeKey, reportedModel, client, hostId, worktreeId, dispatchCommand } = args
  const { onAgentPicker } = args
  const catalog = useMemo(
    // Widening this to a `defaultModelIsCliDefault` catalog (grok) also needs the
    // effective-model resolution desktop does — `previousModelId` below is tracked-only,
    // so a CLI-default model would render option rows that do nothing when tapped.
    () => (agent === 'claude' || agent === 'codex' ? getAgentSessionOptionCatalog(agent) : null),
    [agent]
  )
  const identity = agent && scopeKey ? `${scopeKey}\0${agent}` : null
  const [version, setVersion] = useState(0)
  const [pendingByIdentity, setPendingByIdentity] = useState<
    Record<string, PendingOperation | undefined>
  >({})
  const pendingId = identity ? (pendingByIdentity[identity]?.id ?? null) : null
  const bump = useCallback(() => setVersion((current) => current + 1), [])
  const activeIdentityRef = useRef(identity)
  const applyQueuesRef = useRef(new Map<string, Promise<void>>())
  const operationTokenRef = useRef(0)

  useLayoutEffect(() => {
    activeIdentityRef.current = identity
    return () => {
      activeIdentityRef.current = null
    }
  }, [identity])

  // Why: the seed catalog carries version-neutral family aliases only, so without
  // this probe the picker cannot offer host-specific variants such as `opus[1m]`.
  const discoveredModels = useDiscoveredAgentCatalogModels({
    agent,
    client,
    hostId,
    worktreeId,
    enabled: Boolean(catalog?.listModels)
  })

  // Seed the current model from live agent status; hook reports are authority
  // over locally dispatched guesses (desktop 'reported' source parity).
  useEffect(() => {
    if (!catalog || !scopeKey || !agent || !reportedModel) {
      return
    }
    // The host's live list first: `claude-opus-5[1m]` would otherwise fall through
    // to the seed's substring rule and match the plain `opus` family row.
    const matched =
      (discoveredModels
        ? matchNativeChatCatalogModelId({ ...catalog, models: discoveredModels }, reportedModel)
        : null) ?? matchNativeChatCatalogModelId(catalog, reportedModel)
    if (!matched) {
      return
    }
    // Why: the same report is re-delivered whenever the tab is re-entered or the
    // status stream reconnects, and a session-start report cannot have observed a
    // `/model` sent after it. Re-applying it would revert the user's pick. Only a
    // report that CHANGES is evidence; the value itself still wins when it does.
    if (getAppliedReportModelId(scopeKey) === matched) {
      return
    }
    setAppliedReportModelId(scopeKey, matched)
    const record = getScopedRecord(scopeKey, agent)
    if (applyNativeChatReportedSessionOptions(record, { model: matched })) {
      bump()
    }
  }, [agent, bump, catalog, discoveredModels, reportedModel, scopeKey])

  const snapshot = useMemo(() => {
    if (!catalog || !scopeKey || !agent) {
      return EMPTY_SNAPSHOT
    }
    // Why: `version` invalidates this memo after in-place record mutations.
    void version
    const record = getScopedRecord(scopeKey, agent)
    return buildNativeChatSessionOptionSnapshot({
      catalog,
      // The snapshot no longer self-heals an unlisted tracked model; every caller
      // reconciles it in, so a value the seed dropped keeps its row and options.
      models: activeModels(catalog, record, discoveredModels),
      record,
      mode: 'live',
      modelLabel: 'Model'
    })
  }, [agent, catalog, discoveredModels, scopeKey, version])

  const runSerialized = useCallback(
    (operationIdentity: string, id: string, run: () => Promise<boolean>): Promise<boolean> => {
      const previous = applyQueuesRef.current.get(operationIdentity) ?? Promise.resolve()
      const runIfCurrent = (): Promise<boolean> =>
        activeIdentityRef.current === operationIdentity ? run() : Promise.resolve(false)
      const chained = previous.then(runIfCurrent, runIfCurrent)
      const tail = chained.then(
        () => undefined,
        () => undefined
      )
      applyQueuesRef.current.set(operationIdentity, tail)
      operationTokenRef.current += 1
      const token = operationTokenRef.current
      setPendingByIdentity((current) => ({
        ...current,
        [operationIdentity]: { id, token }
      }))
      void tail.then(() => {
        if (applyQueuesRef.current.get(operationIdentity) === tail) {
          applyQueuesRef.current.delete(operationIdentity)
        }
        setPendingByIdentity((current) => {
          if (current[operationIdentity]?.token !== token) {
            return current
          }
          const next = { ...current }
          delete next[operationIdentity]
          return next
        })
      })
      return chained
    },
    []
  )

  const setOption = useCallback(
    (id: string, value: SessionOptionValue): Promise<boolean> => {
      if (!catalog || !scopeKey || !agent || !identity) {
        return Promise.resolve(false)
      }
      return runSerialized(identity, id, async () => {
        const record = getScopedRecord(scopeKey, agent)
        const previousModelId = typeof record.model?.value === 'string' ? record.model.value : null
        const apply =
          id === 'model'
            ? catalog.modelApply
            : activeModels(catalog, record, discoveredModels)
                .find((model) => model.id === previousModelId)
                ?.options.find((option) => option.id === id)?.apply
        if (!apply || apply.midSession?.kind === 'agent-picker') {
          return false
        }
        const flipOnly = isFlipOnlyMidSession(apply.midSession)
        const trackedToggle = flipOnly
          ? getTrackedSessionOption(record, previousModelId, id)
          : undefined
        if (flipOnly && !trackedToggle) {
          // Why: a flip from an unknown baseline cannot honor an absolute target.
          return false
        }
        // Why: same absolute target must never re-dispatch a flip (would invert the agent).
        if (flipOnly && trackedToggle?.value === value) {
          return true
        }
        const command = buildNativeChatSessionOptionCommand({
          optionId: id,
          value,
          apply,
          modelId: previousModelId,
          catalog,
          models: activeModels(catalog, record, discoveredModels),
          record
        })
        if (!command) {
          return false
        }
        // Baseline for detecting a hook report or typed command that lands while
        // the dispatch is in flight — the record is shared mutable state and the
        // report effect is not on this queue.
        const trackedBeforeDispatch =
          id === 'model' ? undefined : getTrackedSessionOption(record, previousModelId, id)
        const outcome = await dispatchCommand(command)
        if (outcome === 'rejected') {
          return false
        }
        if (id !== 'model') {
          // Why (desktop parity): `setTrackedSessionOption` resolves the owning
          // model when it commits, not when the command was built. If the model
          // moved during the dispatch, committing now would file this value under
          // the NEW model — claiming an effort the agent was never asked for.
          const modelStill = typeof record.model?.value === 'string' ? record.model.value : null
          if (
            modelStill !== previousModelId ||
            getTrackedSessionOption(record, previousModelId, id) !== trackedBeforeDispatch
          ) {
            return true
          }
        }
        if (id === 'model') {
          if (typeof value === 'string' && previousModelId !== value) {
            // Why: switching models can reset effort/toggles for the destination model.
            delete record.valuesByModel[value]
          }
        }
        // Why: flip-only never heals via agent report — track as applied best-known.
        setTrackedSessionOption(record, id, value, flipOnly ? 'applied' : 'dispatched')
        bump()
        return true
      })
    },
    [agent, bump, catalog, discoveredModels, dispatchCommand, identity, runSerialized, scopeKey]
  )

  const invokeAction = useCallback(
    (id: string): Promise<boolean> => {
      if (!catalog || !scopeKey || !agent || !identity) {
        return Promise.resolve(false)
      }
      return runSerialized(identity, id, async () => {
        const record = getScopedRecord(scopeKey, agent)
        const modelId = typeof record.model?.value === 'string' ? record.model.value : null
        const apply =
          id === 'model'
            ? catalog.modelApply
            : activeModels(catalog, record, discoveredModels)
                .find((model) => model.id === modelId)
                ?.options.find((option) => option.id === id)?.apply
        const midSession = apply?.midSession
        if (midSession?.kind === 'agent-picker') {
          const outcome = midSession.delivery
            ? await dispatchCommand(midSession.command, { delivery: midSession.delivery })
            : await dispatchCommand(midSession.command)
          if (outcome === 'rejected') {
            return false
          }
          clearNativeChatSessionModel(record)
          bump()
          onAgentPicker?.()
          return true
        }
        if (isFlipOnlyMidSession(midSession) && !getTrackedSessionOption(record, modelId, id)) {
          // Why: an unknown baseline remains unknown after one inversion.
          return (await dispatchCommand(midSession.command)) !== 'rejected'
        }
        return false
      })
    },
    [
      agent,
      bump,
      catalog,
      discoveredModels,
      dispatchCommand,
      identity,
      onAgentPicker,
      runSerialized,
      scopeKey
    ]
  )

  const recordCommand = useCallback(
    (command: string): void => {
      if (!catalog || !scopeKey || !agent) {
        return
      }
      const record = getScopedRecord(scopeKey, agent)
      const result = recordNativeChatSessionOptionCommand({
        catalog,
        models: activeModels(catalog, record, discoveredModels),
        record,
        command
      })
      if (result.changed) {
        bump()
      }
      if (result.opensAgentPicker) {
        onAgentPicker?.()
      }
    },
    [agent, bump, catalog, onAgentPicker, scopeKey]
  )

  return useMemo(
    () => ({ snapshot, pendingId, setOption, invokeAction, recordCommand }),
    [snapshot, pendingId, setOption, invokeAction, recordCommand]
  )
}
