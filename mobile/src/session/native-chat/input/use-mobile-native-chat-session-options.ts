import { translate } from '../../../i18n/mobile-i18n'
import {
  SessionOptionApplyError,
  SESSION_OPTION_APPLY_FAILURE_COPY
} from '../../../../../src/shared/native-chat/input/native-chat-session-option-apply-failure'
import {
  sameNativeChatSessionOptionBinding,
  enrichNativeChatSessionOptionBinding,
  nativeChatSessionOptionBindingObservationsEqual,
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
import type {
  SessionOptionsSurface,
  SessionOptionDescriptor,
  SessionOptionValue
} from '../../../../../src/shared/native-chat/input/native-chat-session-options'
import type { NativeChatPtySessionOptionsSurface } from '../../../../../src/shared/native-chat/input/native-chat-pty-session-options'
import {
  clearNativeChatSessionOptionCacheForTests,
  readNativeChatSessionOptionSeedBinding,
  type NativeChatSessionOptionOwner
} from '../../../../../src/shared/native-chat/input/native-chat-session-option-cache'
import { matchNativeChatCatalogModelId } from '../../../../../src/shared/native-chat/input/native-chat-session-option-state'
import { setBoundedScopeCacheEntry } from '../../../../../src/shared/native-chat/native-chat-scope-cache'
import {
  createMobileSurfaceEntry,
  type MobileNativeChatSessionOptionsArgs as HookArgs
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

type PendingOperation = {
  identity: string
  surface: NativeChatPtySessionOptionsSurface
  owner?: NativeChatSessionOptionOwner
  id: string
}
type PendingObservation = {
  operation: PendingOperation
  binding?: NativeChatSessionOptionBinding
}

const EMPTY_SNAPSHOT: SessionOptionDescriptor[] = []
const subscribeEmpty = (): (() => void) => () => {}
const getEmptySnapshot = (): SessionOptionDescriptor[] => EMPTY_SNAPSHOT
const getEmptyBinding = (): undefined => undefined

// Kept across remounts: a repeated hook model is not fresh evidence, and reapplying it would revert a newer pick.
const appliedReportByScope = new Map<
  string,
  { model: string; binding?: NativeChatSessionOptionBinding }
>()

export function clearMobileSessionOptionRecordsForTests(): void {
  clearNativeChatSessionOptionCacheForTests()
  appliedReportByScope.clear()
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
  const [pending, setPending] = useState<PendingObservation | null>(null)
  const ownerObservation = useSyncExternalStore(
    args.owner?.subscribe ?? subscribeEmpty,
    args.owner?.getSnapshot ?? getEmptyBinding,
    args.owner?.getSnapshot ?? getEmptyBinding
  )
  const pendingOwner = pending?.operation.owner
  const pendingObservation = useSyncExternalStore(
    pendingOwner?.subscribe ?? subscribeEmpty,
    pendingOwner?.getSnapshot ?? getEmptyBinding,
    pendingOwner?.getSnapshot ?? getEmptyBinding
  )
  let selectedPending = pending
  if (pending?.binding && pendingObservation) {
    if (sameNativeChatSessionOptionBinding(pending.binding, pendingObservation)) {
      const binding = enrichNativeChatSessionOptionBinding(pending.binding, pendingObservation)
      if (!nativeChatSessionOptionBindingObservationsEqual(pending.binding, binding)) {
        selectedPending = { ...pending, binding }
        setPending(selectedPending)
      }
    }
  }

  useLayoutEffect(() => {
    if (selectedPending?.binding) {
      selectedPending.operation.owner?.captureBinding(selectedPending.binding)
    }
  }, [selectedPending])

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
  useLayoutEffect(() => {
    surface?.reconcileOwner()
  }, [surface, ownerObservation])

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
    const captured = args.owner?.currentBinding()
    if (args.owner && !captured) {
      return
    }
    const observed = captured ?? undefined
    const sameOwner =
      !previous?.binding ||
      !observed ||
      sameNativeChatSessionOptionBinding(previous.binding, observed)
    if (!matched) {
      return
    }
    const binding =
      sameOwner && previous?.binding && observed
        ? enrichNativeChatSessionOptionBinding(previous.binding, observed)
        : observed
    if (sameOwner && previous?.model === matched) {
      if (
        binding &&
        (!previous.binding ||
          !nativeChatSessionOptionBindingObservationsEqual(previous.binding, binding))
      ) {
        setBoundedScopeCacheEntry(appliedReportByScope, scopeKey, { model: matched, binding })
      }
      return
    }
    setBoundedScopeCacheEntry(appliedReportByScope, scopeKey, {
      model: matched,
      binding
    })
    surface.reportSessionOptions({ model: matched })
  }, [
    agent,
    catalog,
    discoveredModels,
    reportedModel,
    scopeKey,
    surface,
    args.owner,
    ownerObservation
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
      const operation = { identity, surface, owner: args.owner, id }
      setPending({
        operation,
        binding:
          args.owner?.currentBinding() ??
          (args.owner && scopeKey
            ? readNativeChatSessionOptionSeedBinding(scopeKey, args.owner.binding)
            : undefined)
      })
      return run(surface)
        .then(
          () => true,
          (error: unknown) => {
            const currentBinding = latest.current.owner?.currentBinding()
            if (
              error instanceof SessionOptionApplyError &&
              (error.code === 'controlUnavailable' || error.code === 'controlNotSent') &&
              activeIdentityRef.current === operation.identity &&
              latest.current.isDispatchTargetCurrent?.() !== false &&
              (!operation.owner ||
                (currentBinding &&
                  sameNativeChatSessionOptionBinding(
                    operation.owner.getSnapshot(),
                    currentBinding
                  )))
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
          setPending((current) => (current?.operation === operation ? null : current))
        })
    },
    [identity, surface, args.owner, scopeKey]
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
    selectedPending &&
    selectedPending.operation.identity === identity &&
    (selectedPending.binding && ownerObservation
      ? sameNativeChatSessionOptionBinding(selectedPending.binding, ownerObservation)
      : selectedPending.operation.surface === surface)
      ? selectedPending.operation.id
      : null

  return useMemo(
    () => ({ snapshot, pendingId, setOption, invokeAction, recordCommand }),
    [snapshot, pendingId, setOption, invokeAction, recordCommand]
  )
}
