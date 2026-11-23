import type { AgentSessionConversationCommand } from '../../../../../../src/shared/agent-session/conversation-context/agent-session-conversation-command'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { getAgentSessionOptionCatalog } from '../../../../../../src/shared/agent-session/options/agent-session-option-catalog'
import type {
  CatalogCommandDelivery,
  CatalogModel
} from '../../../../../../src/shared/agent-session/options/catalog-providers/agent-session-option-catalog-types'
import type {
  NativeChatSessionOptionSettingsMutation,
  SessionOptionsSurface,
  SessionOptionDescriptor,
  SessionOptionValue
} from '../../../../../../src/shared/native-chat/input/native-chat-session-options'
import type { MobileNativeChatSendOutcome } from '../../composer/delivery/mobile-native-chat-send'
import {
  createNativeChatPtySessionOptions,
  type NativeChatPtySessionOptionsSurface
} from '../../../../../../src/shared/native-chat/input/session-options/native-chat-pty-session-options'
import {
  readNativeChatSessionOptionCache,
  writeNativeChatSessionOptionCache
} from '../../../../../../src/shared/native-chat/input/session-options/native-chat-session-option-cache'
import { createNativeChatSessionOptionRecord } from '../../../../../../src/shared/native-chat/input/session-options/native-chat-session-option-state'
import {
  takeNativeChatStatusReport,
  type NativeChatStatusReportMemory
} from '../../../../../../src/shared/native-chat/input/session-options/native-chat-status-session-options'
import { setBoundedScopeCacheEntry } from '../../../../../../src/shared/native-chat/input/composer/native-chat-scope-cache'
import { nativeChatCommandOpensTerminal } from '../../../../../../src/shared/native-chat/input/commands/native-chat-agent-profiles'
import { sayMobileNativeChatSessionOption } from './native-chat-session-option-copy'
import { useMobileNativeChatAppliedSessionOptionSeed } from './use-mobile-native-chat-applied-session-option-seed'

export type MobileNativeChatSessionOptionsController = {
  optionSurface?: SessionOptionsSurface
  conversationCommands?: readonly AgentSessionConversationCommand[]
  compactInstructions?: boolean
  optionPickerRequest?: { id: string; sequence: number } | null
  snapshot: SessionOptionDescriptor[]
  pendingId: string | null
  /** Structured picks are taken before the chat attaches and applied when it does. */
  appliesOnAttach?: boolean
  /** A pick waits for the chat to attach. */
  heldPick?: boolean
  setOption: (id: string, value: SessionOptionValue) => Promise<boolean>
  invokeAction: (id: string) => Promise<boolean>
  recordCommand: (command: string) => void
}

type PendingOperation = { identity: string; id: string }
type SurfaceEntry = {
  agent: string
  canSwitchOmpModel: boolean
  surface: NativeChatPtySessionOptionsSurface
  /** The discovered list last handed to the surface. */
  models: readonly CatalogModel[] | null
  /** Set once the tab runs another agent: its late writes must not overwrite the new agent's cache. */
  retired: boolean
}
type HookArgs = {
  agent: string | null
  scopeKey: string | null
  appliedSessionOptions?: Record<string, SessionOptionValue>
  reportedModel: string | null
  reportedEffort?: string
  reportingSessionId?: string
  discoveredModels?: CatalogModel[] | null
  modelSwitchCommand?: string
  dispatchCommand: (
    command: string,
    options?: { delivery?: CatalogCommandDelivery }
  ) => Promise<MobileNativeChatSendOutcome>
  onAgentPicker?: () => void
  /** Saves picks as the host's launch defaults, as desktop does. */
  writeSettings?: (mutation: NativeChatSessionOptionSettingsMutation) => void
}

const EMPTY_SNAPSHOT: SessionOptionDescriptor[] = []
const subscribeEmpty = (): (() => void) => () => {}
const getEmptySnapshot = (): SessionOptionDescriptor[] => EMPTY_SNAPSHOT

// Kept across remounts: the same session repeating its model and effort is not fresh evidence, and reapplying it would revert a newer pick.
const appliedReportByScope: NativeChatStatusReportMemory = new Map()

/** A tab that runs another agent starts over: a new session there carries none of the old one's picks. */
function startScopeOverForAgent(scopeKey: string, agent: string): void {
  const cachedAgent = readNativeChatSessionOptionCache(scopeKey)?.agent
  if (cachedAgent !== undefined && cachedAgent !== agent) {
    writeNativeChatSessionOptionCache(scopeKey, createNativeChatSessionOptionRecord(agent))
    appliedReportByScope.delete(scopeKey)
  }
}

function createMobileSurfaceEntry(args: {
  agent: string
  scopeKey: string
  identity: string
  canSwitchOmpModel: boolean
  latest: { readonly current: HookArgs }
  activeIdentity: { readonly current: string | null }
}): SurfaceEntry | null {
  const { agent, identity, latest, activeIdentity } = args
  const midSession = getAgentSessionOptionCatalog(agent)?.modelApply.midSession
  // Phone-only: desktop confirms a Claude model switch on its terminal screen; the phone cannot, so it never saves one as a launch default.
  const modelSwitchUnconfirmable =
    midSession?.kind === 'command' && midSession.detectAgentInteraction !== undefined
  const surface = createNativeChatPtySessionOptions({
    agent,
    scopeKey: args.scopeKey,
    mode: 'live',
    modelLabel: sayMobileNativeChatSessionOption('model'),
    canSwitchOmpModel: args.canSwitchOmpModel,
    dispatchCommand: async (command, options) => {
      // One controller serves every tab: a queued pick must not reach the tab opened since.
      if (activeIdentity.current !== identity) {
        throw new Error('The chat changed before the command was sent.')
      }
      const outcome = options?.delivery
        ? await latest.current.dispatchCommand(command, { delivery: options.delivery })
        : await latest.current.dispatchCommand(command)
      if (entry.retired) {
        throw new Error('The tab started another agent.')
      }
      // Desktop commits a pick only after the terminal confirms the write.
      if (outcome === 'rejected' || outcome === 'unknown') {
        throw new Error('The terminal did not accept the command.')
      }
    },
    onAgentPicker: () => {
      if (activeIdentity.current === identity) {
        latest.current.onAgentPicker?.()
      }
    },
    persistSelection: (pick) => {
      // A pick that lands after the phone moved to another host's chat must not become that host's default.
      if (
        activeIdentity.current !== identity ||
        (modelSwitchUnconfirmable && pick.optionId === 'model')
      ) {
        return
      }
      latest.current.writeSettings?.({
        type: 'apply-picks',
        agent,
        picks: [modelSwitchUnconfirmable ? { ...pick, adoptModelAsLaunchDefault: false } : pick]
      })
    }
  })
  if (!surface) {
    return null
  }
  const entry: SurfaceEntry = {
    agent,
    canSwitchOmpModel: args.canSwitchOmpModel,
    models: null,
    retired: false,
    surface
  }
  return entry
}

export function useMobileNativeChatSessionOptions(
  args: HookArgs
): MobileNativeChatSessionOptionsController {
  const { agent, scopeKey, reportedModel, reportedEffort, reportingSessionId, discoveredModels } =
    args
  const catalog = agent ? getAgentSessionOptionCatalog(agent) : null
  const identity = agent && scopeKey && catalog ? `${scopeKey}\0${agent}` : null
  const canSwitchOmpModel = args.modelSwitchCommand === 'orca-model'
  const latest = useRef(args)
  const activeIdentityRef = useRef(identity)
  const [pending, setPending] = useState<PendingOperation | null>(null)
  // One surface per tab for this controller's life: a pick still on its way lands where the chat shows it on return.
  const [surfaces] = useState(() => new Map<string, SurfaceEntry>())

  useLayoutEffect(() => {
    latest.current = args
  })
  useLayoutEffect(() => {
    activeIdentityRef.current = identity
    return () => {
      activeIdentityRef.current = null
    }
  }, [identity])

  const entry = useMemo(() => {
    if (!identity || !agent || !scopeKey) {
      return null
    }
    const kept = surfaces.get(scopeKey)
    // A changed OMP switch capability rebuilds from the cache, which holds the latest selection.
    if (kept && kept.agent === agent && kept.canSwitchOmpModel === canSwitchOmpModel) {
      setBoundedScopeCacheEntry(surfaces, scopeKey, kept)
      return kept
    }
    if (kept && kept.agent !== agent) {
      kept.retired = true
    }
    startScopeOverForAgent(scopeKey, agent)
    const created = createMobileSurfaceEntry({
      agent,
      scopeKey,
      identity,
      canSwitchOmpModel,
      latest,
      activeIdentity: activeIdentityRef
    })
    if (created) {
      setBoundedScopeCacheEntry(surfaces, scopeKey, created)
    }
    return created
  }, [agent, canSwitchOmpModel, identity, scopeKey, surfaces])
  const surface = entry?.surface ?? null
  useMobileNativeChatAppliedSessionOptionSeed(surface, args.appliedSessionOptions)

  useEffect(() => {
    if (entry && discoveredModels && entry.models !== discoveredModels) {
      entry.models = discoveredModels
      entry.surface.replaceModels(discoveredModels)
    }
  }, [discoveredModels, entry])

  useEffect(() => {
    if (!surface || !scopeKey || !agent || !catalog || !reportedModel) {
      return
    }
    // A restarted session reports afresh, even the same model and effort.
    const report = takeNativeChatStatusReport(
      appliedReportByScope,
      scopeKey,
      agent,
      catalog,
      discoveredModels ?? catalog.models,
      { model: reportedModel, providerSession: { id: reportingSessionId, effort: reportedEffort } }
    )
    if (report) {
      surface.reportSessionOptions(report.values, report.forNewModel)
    }
  }, [
    agent,
    catalog,
    discoveredModels,
    reportedEffort,
    reportedModel,
    reportingSessionId,
    scopeKey,
    surface
  ])

  const snapshot = useSyncExternalStore(
    surface?.subscribe ?? subscribeEmpty,
    surface?.getSnapshot ?? getEmptySnapshot,
    surface?.getSnapshot ?? getEmptySnapshot
  )

  const track = useCallback(
    (id: string, run: (target: NativeChatPtySessionOptionsSurface) => Promise<unknown>) => {
      if (!surface || !identity) {
        return Promise.resolve(false)
      }
      const operation = { identity, id }
      setPending(operation)
      return run(surface)
        .then(
          () => true,
          () => false
        )
        .finally(() => {
          setPending((current) => (current === operation ? null : current))
        })
    },
    [identity, surface]
  )
  const setOption = useCallback(
    (id: string, value: SessionOptionValue) => track(id, (target) => target.setOption(id, value)),
    [track]
  )
  const invokeAction = useCallback(
    (id: string) => track(id, (target) => target.invokeAction(id)),
    [track]
  )
  const recordCommand = useCallback(
    (command: string) => {
      surface?.recordOutgoingCommand(command)
      // Why: later chat sends would be typed into the TUI screen this command opened; a send that lands after the phone moved to another chat or agent must not switch that one.
      if (
        agent &&
        latest.current.scopeKey === scopeKey &&
        latest.current.agent === agent &&
        nativeChatCommandOpensTerminal(agent, command)
      ) {
        latest.current.onAgentPicker?.()
      }
    },
    [agent, scopeKey, surface]
  )
  const pendingId = pending && pending.identity === identity ? pending.id : null

  return useMemo(
    () => ({ snapshot, pendingId, setOption, invokeAction, recordCommand }),
    [snapshot, pendingId, setOption, invokeAction, recordCommand]
  )
}
