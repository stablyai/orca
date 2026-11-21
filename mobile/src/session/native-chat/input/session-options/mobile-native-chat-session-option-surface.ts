import { getAgentSessionOptionCatalog } from '../../../../../../src/shared/agent-session/options/agent-session-option-catalog'
import type {
  CatalogCommandDelivery,
  CatalogModel
} from '../../../../../../src/shared/agent-session/options/catalog-providers/agent-session-option-catalog-types'
import type { NativeChatSessionOptionSettingsMutation } from '../../../../../../src/shared/native-chat/input/native-chat-session-options'
import type { MobileNativeChatSendOutcome } from '../../composer/delivery/mobile-native-chat-send'
import { createNativeChatPtySessionOptions } from '../../../../../../src/shared/native-chat/input/session-options/native-chat-pty-session-options'
import type { NativeChatPtySessionOptionsSurface } from '../../../../../../src/shared/native-chat/input/session-options/native-chat-pty-session-options'
import {
  readNativeChatSessionOptionCache,
  writeNativeChatSessionOptionCache
} from '../../../../../../src/shared/native-chat/input/session-options/native-chat-session-option-cache'
import { createNativeChatSessionOptionRecord } from '../../../../../../src/shared/native-chat/input/session-options/native-chat-session-option-state'
import { clearMobileNativeChatAppliedReport } from './mobile-native-chat-applied-report'
import { sayMobileNativeChatSessionOption } from './native-chat-session-option-copy'

export type MobileSessionOptionSurfaceEntry = {
  agent: string
  canSwitchOmpModel: boolean
  surface: NativeChatPtySessionOptionsSurface
  /** The discovered list last handed to the surface. */
  models: readonly CatalogModel[] | null
  /** Set while a discovered catalog is hidden and its refresh has not settled. */
  awaitingRefresh: boolean
  /** Set once the tab runs another agent: its late writes must not overwrite the new agent's cache. */
  retired: boolean
}

type SurfaceLatest = {
  readonly current: {
    dispatchCommand: (
      command: string,
      options?: { delivery?: CatalogCommandDelivery }
    ) => Promise<MobileNativeChatSendOutcome>
    onAgentPicker?: () => void
    writeSettings?: (mutation: NativeChatSessionOptionSettingsMutation) => void
  }
}

/** A tab that runs another agent starts over: a new session there carries none of the old one's picks. */
export function startMobileSessionOptionScope(scopeKey: string, agent: string): void {
  const cachedAgent = readNativeChatSessionOptionCache(scopeKey)?.agent
  if (cachedAgent !== undefined && cachedAgent !== agent) {
    writeNativeChatSessionOptionCache(scopeKey, createNativeChatSessionOptionRecord(agent))
    clearMobileNativeChatAppliedReport(scopeKey)
  }
}

export function agentDiscoversModels(agent: string | null): boolean {
  if (!agent) {
    return false
  }
  if (agent === 'claude') {
    return true
  }
  const listed = getAgentSessionOptionCatalog(agent)
  return listed?.listModels !== undefined && listed.discoveredModelsAreAuthoritative === true
}

export function createMobileSurfaceEntry(args: {
  agent: string
  scopeKey: string
  identity: string
  canSwitchOmpModel: boolean
  awaitingRefresh: boolean
  latest: SurfaceLatest
  activeIdentity: { readonly current: string | null }
}): MobileSessionOptionSurfaceEntry | null {
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
  const entry: MobileSessionOptionSurfaceEntry = {
    agent,
    canSwitchOmpModel: args.canSwitchOmpModel,
    models: null,
    awaitingRefresh: args.awaitingRefresh,
    retired: false,
    surface
  }
  return entry
}
