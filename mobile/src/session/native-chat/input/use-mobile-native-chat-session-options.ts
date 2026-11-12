import { translate } from '../../../i18n/mobile-i18n'
import {
  SessionOptionApplyError,
  SESSION_OPTION_APPLY_FAILURE_COPY
} from '../../../../../src/shared/native-chat/input/native-chat-session-option-apply-failure'
import {
  sameNativeChatSessionOptionBinding,
  type NativeChatSessionOptionBinding
} from '../../../../../src/shared/native-chat/input/native-chat-session-option-binding'
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
import type { CatalogModel } from '../../../../../src/shared/agent-session/options/agent-session-option-catalog-types'
import type {
  NativeChatSessionOptionSettingsMutation,
  SessionOptionsSurface,
  SessionOptionDescriptor,
  SessionOptionValue
} from '../../../../../src/shared/native-chat/input/native-chat-session-options'
import type { MobileNativeChatSendOutcome } from '../mobile-native-chat-send'
import type {
  NativeChatSessionOptionDispatchOptions,
  NativeChatSessionOptionDispatchResult
} from '../../../../../src/shared/native-chat/input/native-chat-session-option-dispatch'
import {
  createNativeChatPtySessionOptions,
  type NativeChatPtySessionOptionsSurface
} from '../../../../../src/shared/native-chat/input/native-chat-pty-session-options'
import {
  clearNativeChatSessionOptionCacheForTests,
  type NativeChatSessionOptionOwner
} from '../../../../../src/shared/native-chat/input/native-chat-session-option-cache'
import { matchNativeChatCatalogModelId } from '../../../../../src/shared/native-chat/input/native-chat-session-option-state'
import { setBoundedScopeCacheEntry } from '../../../../../src/shared/native-chat/native-chat-scope-cache'
import { sayMobileNativeChatSessionOption } from './native-chat-session-option-copy'

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

type PendingOperation = {
  identity: string
  surface: NativeChatPtySessionOptionsSurface
  owner?: NativeChatSessionOptionOwner
  id: string
}
type SurfaceEntry = {
  agent: string
  canSwitchOmpModel: boolean
  surface: NativeChatPtySessionOptionsSurface
  /** The discovered list last handed to the surface. */
  models: readonly CatalogModel[] | null
}
type HookArgs = {
  agent: string | null
  owner?: NativeChatSessionOptionOwner
  isDispatchTargetCurrent?: () => boolean
  scopeKey: string | null
  reportedModel: string | null
  discoveredModels?: CatalogModel[] | null
  modelSwitchCommand?: string
  dispatchCommand: (
    command: string,
    options?: NativeChatSessionOptionDispatchOptions
  ) => Promise<MobileNativeChatSendOutcome | NativeChatSessionOptionDispatchResult>
  onAgentPicker?: () => void
  onControlError?: (message: string) => void
  /** Saves picks as the host's launch defaults, as desktop does. */
  writeSettings?: (mutation: NativeChatSessionOptionSettingsMutation) => void
}

const EMPTY_SNAPSHOT: SessionOptionDescriptor[] = []
const subscribeEmpty = (): (() => void) => () => {}
const getEmptySnapshot = (): SessionOptionDescriptor[] => EMPTY_SNAPSHOT

// Kept across remounts: a repeated hook model is not fresh evidence, and reapplying it would revert a newer pick.
const appliedReportByScope = new Map<
  string,
  { model: string; binding?: NativeChatSessionOptionBinding }
>()

export function clearMobileSessionOptionRecordsForTests(): void {
  clearNativeChatSessionOptionCacheForTests()
  appliedReportByScope.clear()
}

function createMobileSurfaceEntry(args: {
  agent: string
  scopeKey: string
  identity: string
  canSwitchOmpModel: boolean
  latest: { readonly current: HookArgs }
  activeIdentity: { readonly current: string | null }
  captured: HookArgs
}): SurfaceEntry | null {
  const { agent, identity, latest, activeIdentity } = args
  const midSession = getAgentSessionOptionCatalog(agent)?.modelApply.midSession
  // Phone-only: desktop confirms a Claude model switch on its terminal screen; the phone cannot, so it never saves one as a launch default.
  const modelSwitchUnconfirmable =
    midSession?.kind === 'command' && midSession.detectAgentInteraction !== undefined
  const surface = createNativeChatPtySessionOptions({
    agent,
    owner: args.captured.owner,
    scopeKey: args.scopeKey,
    mode: 'live',
    modelLabel: sayMobileNativeChatSessionOption('model'),
    canSwitchOmpModel: args.canSwitchOmpModel,
    dispatchCommand: async (command, options) => {
      // One controller serves every tab: a queued pick must not reach the tab opened since.
      if (
        activeIdentity.current !== identity ||
        args.captured.isDispatchTargetCurrent?.() === false
      ) {
        throw new Error('The chat changed before the command was sent.')
      }
      const outcome = await args.captured.dispatchCommand(command, options)
      if (typeof outcome === 'object') {
        return outcome
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
      if (modelSwitchUnconfirmable && pick.optionId === 'model') {
        return
      }
      args.captured.writeSettings?.({
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
    surface
  }
  return entry
}

export function useMobileNativeChatSessionOptions(
  args: HookArgs
): MobileNativeChatSessionOptionsController {
  const { agent, scopeKey, reportedModel, discoveredModels } = args
  const catalog = agent ? getAgentSessionOptionCatalog(agent) : null
  const identity = agent && scopeKey && catalog ? `${scopeKey}\0${agent}` : null
  const canSwitchOmpModel = args.modelSwitchCommand === 'orca-model'
  const latest = useRef(args)
  const activeIdentityRef = useRef(identity)
  const [pending, setPending] = useState<PendingOperation | null>(null)

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
    const created = createMobileSurfaceEntry({
      agent,
      scopeKey,
      identity,
      canSwitchOmpModel,
      latest,
      activeIdentity: activeIdentityRef,
      captured: args
    })
    return created
  }, [
    agent,
    canSwitchOmpModel,
    identity,
    scopeKey,
    args.owner,
    args.dispatchCommand,
    args.writeSettings
  ])
  const surface = entry?.surface ?? null

  useEffect(() => {
    if (entry && discoveredModels && entry.models !== discoveredModels) {
      entry.models = discoveredModels
      entry.surface.replaceModels(discoveredModels)
    }
  }, [discoveredModels, entry])

  useEffect(() => {
    if (!surface || !scopeKey || !catalog || !reportedModel) {
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
            { allowUnlisted: agent === 'codex' }
          )
    const previous = appliedReportByScope.get(scopeKey)
    const sameOwner =
      !previous?.binding ||
      !args.owner ||
      sameNativeChatSessionOptionBinding(previous.binding, args.owner.binding)
    if (!matched || (sameOwner && previous?.model === matched)) {
      return
    }
    setBoundedScopeCacheEntry(appliedReportByScope, scopeKey, {
      model: matched,
      binding: args.owner?.binding
    })
    surface.reportSessionOptions({ model: matched })
  }, [agent, catalog, discoveredModels, reportedModel, scopeKey, surface, args.owner])

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
      const operation = { identity, surface, owner: args.owner, id }
      setPending(operation)
      return run(surface)
        .then(
          () => true,
          (error: unknown) => {
            const currentBinding = operation.owner?.readCurrentBinding()
            if (
              error instanceof SessionOptionApplyError &&
              (error.code === 'controlUnavailable' || error.code === 'controlNotSent') &&
              activeIdentityRef.current === operation.identity &&
              args.isDispatchTargetCurrent?.() !== false &&
              (!operation.owner ||
                (currentBinding &&
                  sameNativeChatSessionOptionBinding(operation.owner.binding, currentBinding)))
            ) {
              latest.current.onControlError?.(
                translate(
                  `chat.sessionOptionErrors.${error.code}`,
                  SESSION_OPTION_APPLY_FAILURE_COPY[error.code],
                  { agent: error.agent ?? '' }
                )
              )
            }
            return false
          }
        )
        .finally(() => {
          setPending((current) => (current === operation ? null : current))
        })
    },
    [identity, surface, args.owner]
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
  const pendingId =
    pending &&
    pending.identity === identity &&
    (pending.owner && args.owner
      ? sameNativeChatSessionOptionBinding(pending.owner.binding, args.owner.binding)
      : pending.surface === surface)
      ? pending.id
      : null

  return useMemo(
    () => ({ snapshot, pendingId, setOption, invokeAction, recordCommand }),
    [snapshot, pendingId, setOption, invokeAction, recordCommand]
  )
}
