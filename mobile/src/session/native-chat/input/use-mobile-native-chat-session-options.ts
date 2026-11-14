import type { ClaudeSessionStatus } from '../../../../../src/shared/native-chat/claude-session-status'
import type { AgentSessionConversationCommand } from '../../../../../src/shared/agent-session/agent-session-conversation-command'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { getAgentSessionOptionCatalog } from '../../../../../src/shared/agent-session/options/agent-session-option-catalog'
import type {
  CatalogCommandDelivery,
  CatalogModel
} from '../../../../../src/shared/agent-session/options/agent-session-option-catalog-types'
import type {
  NativeChatSessionOptionSettingsMutation,
  SessionOptionsSurface,
  SessionOptionDescriptor,
  SessionOptionValue
} from '../../../../../src/shared/native-chat/input/native-chat-session-options'
import type { MobileNativeChatSendOutcome } from '../composer/mobile-native-chat-send'
import {
  createNativeChatPtySessionOptions,
  type NativeChatPtySessionOptionsSurface
} from '../../../../../src/shared/native-chat/input/native-chat-pty-session-options'
import {
  readNativeChatSessionOptionCache,
  writeNativeChatSessionOptionCache
} from '../../../../../src/shared/native-chat/input/native-chat-session-option-cache'
import {
  createNativeChatSessionOptionRecord,
  matchNativeChatCatalogModelId
} from '../../../../../src/shared/native-chat/input/native-chat-session-option-state'
import { setBoundedScopeCacheEntry } from '../../../../../src/shared/native-chat/native-chat-scope-cache'
import { sayMobileNativeChatSessionOption } from './native-chat-session-option-copy'

export type MobileNativeChatSessionOptionsController = {
  /** Read by the composer's status row; only a terminal-backed Claude chat has one. */
  claudeSessionStatus?: ClaudeSessionStatus | null
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
  reportedModel: string | null
  /** The session file's view of the chat; its model outranks the hook's. */
  sessionReport?: ClaudeSessionStatus | null
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

// Kept across remounts: a repeated hook model is not fresh evidence, and reapplying it would revert a newer pick.
const appliedReportByScope = new Map<string, string>()
// Apart from the hook's: the hook model lands first on each visit and must not make the same reply look new.
const appliedFileReportByScope = new Map<string, string>()

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
  const { agent, scopeKey, reportedModel, discoveredModels } = args
  const fileModel = args.sessionReport?.model ?? null
  const fileEffort = args.sessionReport?.effort ?? null
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

  useEffect(() => {
    if (entry && discoveredModels && entry.models !== discoveredModels) {
      entry.models = discoveredModels
      entry.surface.replaceModels(discoveredModels)
    }
  }, [discoveredModels, entry])

  useEffect(() => {
    const reported = fileModel ?? reportedModel
    if (!surface || !scopeKey || !catalog || !reported) {
      return
    }
    // Phone-only: desktop reads Claude's model from its terminal screen, which the phone cannot see, so Claude keeps the hook model too.
    // OMP reports exact selectors, including models absent from cached discovery.
    const searched = { ...catalog, models: discoveredModels ?? catalog.models }
    const listed =
      agent === 'omp'
        ? reported.trim()
        : matchNativeChatCatalogModelId(searched, reported, { allowUnlisted: agent === 'codex' })
    // The session file names the model that actually answered, even one this catalog predates.
    const matched =
      listed ??
      (fileModel
        ? matchNativeChatCatalogModelId(searched, reported, { allowUnlisted: true })
        : null)
    const applied = fileEffort ? `${matched}\0${fileEffort}` : matched
    const appliedByScope = fileModel ? appliedFileReportByScope : appliedReportByScope
    if (!matched || !applied || appliedByScope.get(scopeKey) === applied) {
      return
    }
    setBoundedScopeCacheEntry(appliedByScope, scopeKey, applied)
    surface.reportSessionOptions(
      fileEffort ? { model: matched, effort: fileEffort } : { model: matched }
    )
  }, [agent, catalog, discoveredModels, fileEffort, fileModel, reportedModel, scopeKey, surface])

  const liveSnapshot = useSyncExternalStore(
    surface?.subscribe ?? subscribeEmpty,
    surface?.getSnapshot ?? getEmptySnapshot,
    surface?.getSnapshot ?? getEmptySnapshot
  )
  // The catalog names a family; the session file names the version that actually answered.
  const snapshot = useMemo(
    () =>
      fileModel
        ? liveSnapshot.map((descriptor) =>
            descriptor.category === 'model' && descriptor.valueSource === 'reported'
              ? { ...descriptor, reportedModel: fileModel }
              : descriptor
          )
        : liveSnapshot,
    [fileModel, liveSnapshot]
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
    (command: string) => surface?.recordOutgoingCommand(command),
    [surface]
  )
  const pendingId = pending && pending.identity === identity ? pending.id : null

  return useMemo(
    () => ({
      snapshot,
      pendingId,
      setOption,
      invokeAction,
      recordCommand,
      claudeSessionStatus: args.sessionReport
    }),
    [snapshot, pendingId, setOption, invokeAction, recordCommand, args.sessionReport]
  )
}
