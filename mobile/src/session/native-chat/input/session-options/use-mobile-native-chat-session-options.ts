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
import type { NativeChatPtySessionOptionsSurface } from '../../../../../../src/shared/native-chat/input/session-options/native-chat-pty-session-options'
import {
  matchNativeChatCatalogModelId,
  selectedSessionOptionValue
} from '../../../../../../src/shared/native-chat/input/session-options/native-chat-session-option-state'
import { setBoundedScopeCacheEntry } from '../../../../../../src/shared/native-chat/input/composer/native-chat-scope-cache'
import { nativeChatCommandOpensTerminal } from '../../../../../../src/shared/native-chat/input/commands/native-chat-agent-profiles'
import {
  clearMobileNativeChatAppliedReport,
  rememberMobileNativeChatAppliedReport
} from './mobile-native-chat-applied-report'
import { syncMobileDiscoveredModels } from './mobile-native-chat-discovered-model-refresh'
import {
  agentDiscoversModels,
  createMobileSurfaceEntry,
  startMobileSessionOptionScope,
  type MobileSessionOptionSurfaceEntry
} from './mobile-native-chat-session-option-surface'

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
type SurfaceEntry = MobileSessionOptionSurfaceEntry
type HookArgs = {
  agent: string | null
  scopeKey: string | null
  reportedModel: string | null
  discoveredModels?: CatalogModel[] | null
  /** The refresh that cleared `discoveredModels` failed, so a stale discovered route must drop. */
  discoveryFailed?: boolean
  /** False while the terminal is showing. Omitted stays in chat. */
  chatVisible?: boolean
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

export function useMobileNativeChatSessionOptions(
  args: HookArgs
): MobileNativeChatSessionOptionsController {
  const { agent, scopeKey, reportedModel, discoveredModels } = args
  const discoveryFailed = args.discoveryFailed === true
  const chatVisible = args.chatVisible !== false
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

  const discoveryWired = Object.hasOwn(args, 'discoveredModels')
  const awaitDiscovery =
    chatVisible &&
    discoveryWired &&
    agentDiscoversModels(agent) &&
    !discoveryFailed &&
    discoveredModels == null
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
    startMobileSessionOptionScope(scopeKey, agent)
    const created = createMobileSurfaceEntry({
      agent,
      scopeKey,
      identity,
      canSwitchOmpModel,
      awaitingRefresh: awaitDiscovery,
      latest,
      activeIdentity: activeIdentityRef
    })
    if (created) {
      setBoundedScopeCacheEntry(surfaces, scopeKey, created)
    }
    return created
  }, [agent, awaitDiscovery, canSwitchOmpModel, identity, scopeKey, surfaces])
  const surface = entry?.surface ?? null

  useEffect(() => {
    if (!entry) {
      return
    }
    if (awaitDiscovery && !entry.models) {
      entry.awaitingRefresh = true
    }
    syncMobileDiscoveredModels(entry, discoveredModels, discoveryFailed, scopeKey)
  }, [awaitDiscovery, discoveredModels, discoveryFailed, entry, scopeKey])

  useEffect(() => {
    if (scopeKey && !chatVisible) {
      clearMobileNativeChatAppliedReport(scopeKey)
      return
    }
    if (!surface || !scopeKey || !catalog || !reportedModel || entry?.awaitingRefresh) {
      return
    }
    // Phone-only: desktop reads Claude's model from its terminal screen, which the phone cannot see, so Claude keeps the hook model too.
    // OMP reports exact selectors, including models absent from cached discovery.
    const matched =
      agent === 'omp'
        ? reportedModel.trim()
        : matchNativeChatCatalogModelId(
            { ...catalog, models: discoveredModels ?? catalog.models },
            reportedModel,
            {
              allowUnlisted: agent === 'codex',
              selectedId: selectedSessionOptionValue(surface.getSnapshot(), 'model')
            }
          )
    if (!matched || !rememberMobileNativeChatAppliedReport(scopeKey, matched)) {
      return
    }
    surface.reportSessionOptions({ model: matched })
  }, [
    agent,
    catalog,
    chatVisible,
    discoveredModels,
    discoveryFailed,
    entry,
    reportedModel,
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
