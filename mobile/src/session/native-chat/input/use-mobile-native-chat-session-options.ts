import { appliedReportByScope, getScopedRecord } from '../../mobile-session-option-records'
import { mobileOmpSessionCatalog } from '../../mobile-omp-session-catalog'
import type { AgentSessionConversationCommand } from '../../../../../src/shared/agent-session/agent-session-conversation-command'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { getAgentSessionOptionCatalog } from '../../../../../src/shared/agent-session-option-catalog'
import type {
  CatalogCommandDelivery,
  CatalogModel
} from '../../../../../src/shared/agent-session-option-catalog-types'
import type {
  SessionOptionsSurface,
  SessionOptionDescriptor,
  SessionOptionValue
} from '../../../../../src/shared/native-chat/input/native-chat-session-options'
import type { MobileNativeChatSendOutcome } from '../mobile-native-chat-send'
import {
  buildNativeChatSessionOptionCommand,
  recordNativeChatSessionOptionCommand
} from '../../../../../src/shared/native-chat/input/native-chat-session-option-commands'
import {
  buildNativeChatSessionOptionSnapshot,
  withTrackedNativeChatModel
} from '../../../../../src/shared/native-chat/input/native-chat-session-option-snapshot'
import {
  applyNativeChatReportedSessionOptions,
  clearNativeChatSessionModel,
  getTrackedSessionOption,
  isFlipOnlyMidSession,
  matchNativeChatCatalogModelId,
  setTrackedSessionOption
} from '../../../../../src/shared/native-chat/input/native-chat-session-option-state'

export type MobileNativeChatSessionOptionsController = {
  optionSurface?: SessionOptionsSurface
  conversationCommands?: readonly AgentSessionConversationCommand[]
  optionPickerRequest?: { id: string; sequence: number } | null
  snapshot: SessionOptionDescriptor[]
  pendingId: string | null
  setOption: (id: string, value: SessionOptionValue) => Promise<boolean>
  invokeAction: (id: string) => Promise<boolean>
  recordCommand: (command: string) => void
}

type PendingOperation = { id: string; token: number }

const EMPTY_SNAPSHOT: SessionOptionDescriptor[] = []

export function useMobileNativeChatSessionOptions(args: {
  agent: string | null
  scopeKey: string | null
  reportedModel: string | null
  discoveredModels?: CatalogModel[] | null
  modelSwitchCommand?: string
  dispatchCommand: (
    command: string,
    options?: { delivery?: CatalogCommandDelivery }
  ) => Promise<MobileNativeChatSendOutcome>
  onAgentPicker?: () => void
}): MobileNativeChatSessionOptionsController {
  const { agent, scopeKey, reportedModel, dispatchCommand, onAgentPicker, discoveredModels } = args
  const baseCatalog = useMemo(
    () =>
      agent === 'claude' || agent === 'codex' || agent === 'omp'
        ? getAgentSessionOptionCatalog(agent)
        : null,
    [agent]
  )
  const catalog = useMemo(
    () =>
      baseCatalog && agent === 'omp'
        ? mobileOmpSessionCatalog(baseCatalog, discoveredModels, args.modelSwitchCommand)
        : baseCatalog,
    [agent, baseCatalog, discoveredModels, args.modelSwitchCommand]
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

  useEffect(() => {
    if (!catalog || !scopeKey || !agent || !reportedModel) {
      return
    }
    // OMP reports exact selectors, including models absent from cached discovery.
    const matched =
      agent === 'omp'
        ? reportedModel.trim()
        : matchNativeChatCatalogModelId(catalog, reportedModel, {
            allowUnlisted: agent === 'codex'
          })
    if (!matched) {
      return
    }
    // Repeated session-start reports predate later picks; only a changed report is fresh evidence allowed to override them.
    if (appliedReportByScope.get(scopeKey) === matched) {
      return
    }
    appliedReportByScope.set(scopeKey, matched)
    const record = getScopedRecord(scopeKey, agent)
    if (applyNativeChatReportedSessionOptions(record, { model: matched })) {
      bump()
    }
  }, [agent, bump, catalog, reportedModel, scopeKey])

  const snapshot = useMemo(() => {
    if (!catalog || !scopeKey || !agent) {
      return EMPTY_SNAPSHOT
    }
    void version
    const record = getScopedRecord(scopeKey, agent)
    return buildNativeChatSessionOptionSnapshot({
      catalog,
      // Reconcile tracked models absent from discovery so their rows/options survive stale catalog data.
      models: withTrackedNativeChatModel(catalog, catalog.models, record),
      record,
      mode: 'live',
      modelLabel: 'Model',
      liveTransport: 'catalog'
    })
  }, [agent, catalog, scopeKey, version])

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
            : withTrackedNativeChatModel(catalog, catalog.models, record)
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
          return false
        }
        if (flipOnly && trackedToggle?.value === value) {
          return true
        }
        const command = buildNativeChatSessionOptionCommand({
          optionId: id,
          value,
          apply,
          modelId: previousModelId,
          catalog,
          models: withTrackedNativeChatModel(catalog, catalog.models, record),
          record
        })
        if (!command) {
          return false
        }
        // Capture the dispatch baseline because live reports/typed commands mutate the shared record outside this queue.
        const trackedBeforeDispatch =
          id === 'model' ? undefined : getTrackedSessionOption(record, previousModelId, id)
        const outcome = await dispatchCommand(command)
        if (outcome === 'rejected') {
          return false
        }
        if (id !== 'model') {
          // If the model moved during dispatch, never file the old model’s option under its new destination.
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
            delete record.valuesByModel[value]
          }
        }
        // Flip-only controls cannot heal via report; keep their best-known applied state.
        setTrackedSessionOption(record, id, value, flipOnly ? 'applied' : 'dispatched')
        bump()
        return true
      })
    },
    [agent, bump, catalog, dispatchCommand, identity, runSerialized, scopeKey]
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
            : withTrackedNativeChatModel(catalog, catalog.models, record)
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
          return (await dispatchCommand(midSession.command)) !== 'rejected'
        }
        return false
      })
    },
    [agent, bump, catalog, dispatchCommand, identity, onAgentPicker, runSerialized, scopeKey]
  )

  const recordCommand = useCallback(
    (command: string): void => {
      if (!catalog || !scopeKey || !agent) {
        return
      }
      const record = getScopedRecord(scopeKey, agent)
      const result = recordNativeChatSessionOptionCommand({
        catalog,
        models: withTrackedNativeChatModel(catalog, catalog.models, record),
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
