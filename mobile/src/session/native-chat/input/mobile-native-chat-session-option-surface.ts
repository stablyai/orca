import { getAgentSessionOptionCatalog } from '../../../../../src/shared/agent-session/options/agent-session-option-catalog'
import type { CatalogModel } from '../../../../../src/shared/agent-session/options/agent-session-option-catalog-types'
import {
  createNativeChatPtySessionOptions,
  type NativeChatPtySessionOptionsSurface
} from '../../../../../src/shared/native-chat/input/native-chat-pty-session-options'
import type { NativeChatSessionOptionSettingsMutation } from '../../../../../src/shared/native-chat/input/native-chat-session-options'
import type {
  NativeChatSessionOptionDispatchOptions,
  NativeChatSessionOptionDispatchResult
} from '../../../../../src/shared/native-chat/input/native-chat-session-option-dispatch'
import type { NativeChatSessionOptionOwner } from '../../../../../src/shared/native-chat/input/native-chat-session-option-owner'
import type { MobileNativeChatSendOutcome } from '../composer/mobile-native-chat-send'
import { sayMobileNativeChatSessionOption } from './native-chat-session-option-copy'

type SurfaceEntry = {
  agent: string
  canSwitchOmpModel: boolean
  surface: NativeChatPtySessionOptionsSurface
  /** The discovered list last handed to the surface. */
  models: readonly CatalogModel[] | null
}
export type MobileNativeChatSessionOptionsArgs = {
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

export function createMobileSurfaceEntry(args: {
  agent: string
  scopeKey: string
  identity: string
  canSwitchOmpModel: boolean
  latest: { readonly current: MobileNativeChatSessionOptionsArgs }
  activeIdentity: { readonly current: string | null }
  captured: MobileNativeChatSessionOptionsArgs
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
