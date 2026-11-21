import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { RpcSuccess } from '../../../transport/rpc/rpc-wire-types'
import type { BridgeConnectionPathSource } from '../protocol/bridge-connection-snapshot'
import type { BridgeRpcClientDiagnostic } from './bridge-client-diagnostics'
import type { BridgeShellSessionListeners } from './bridge-client-shell-session'
import type { BridgeShellSession } from './bridge-client-session'
import type { BridgeHapticsKind } from '../native-capabilities/bridge-haptics-notify'
import type { BridgeNativeVerb } from '../native-capabilities/bridge-native-verbs'
import type { PageBackConsumer } from '../page-lifecycle/page-back-consumers'
import type { BridgeClearableRouteParam } from '../page-lifecycle/bridge-route-update'
import type { createBridgeClientTerminalKeys } from './bridge-client-terminal-keys'

export type BridgeRpcClientOptions = {
  send: (json: string) => void
  onMessage: (handler: (json: string) => void) => () => void
  onDiagnostic?: (diagnostic: BridgeRpcClientDiagnostic) => void
}

export type BridgeRpcClient = RpcClient &
  BridgeConnectionPathSource &
  Required<Pick<RpcClient, 'getShellHostStatus'>> &
  BridgeShellSessionListeners & {
    /**
     * Asks the shell to draw its key rail, while a terminal and its key row are on screen, until the
     * dispose is called; `listener` takes each press. Nothing is sent to a shell without the grant.
     */
    claimTerminalKeyRail: ReturnType<typeof createBridgeClientTerminalKeys>['claim']
    getShellSession: () => BridgeShellSession | null
    // False without navigate lets tap handlers fall back safely instead of throwing into uncaught UI callbacks.
    notifyNavigate: (href: string, replace?: boolean) => boolean
    // The page owns no native history; ask the shell to pop. Missing grant returns false; older shells may also drop the new notify, so callers retain their router fallback.
    notifyNavigateBack: () => boolean
    // False means missing externalLink grant or refused URL; callers must offer another outcome for the tap.
    notifyExternalLink: (url: string) => boolean
    // Use the existing request/id/cap lane but keep native methods inside the bridge’s typed surface; they are device verbs, not catalogued desktop RPCs.
    callNativeVerb: (verb: BridgeNativeVerb, params: unknown) => Promise<RpcSuccess>
    // How many more native calls the page-side cap admits now; a caller that must keep call order checks it
    // before posting, since a refusal arrives only as a rejected promise.
    nativeRequestRoom: () => number
    // Only the page can report a painted tree; WebView commit and ready happen before that proof exists.
    notifyPagePainted: () => void
    // Where the page has navigated inside its document, so the shell knows which session it shows.
    notifyPageLocation: (href: string) => void
    // Claim Back until disposal; invoke consumers newest-first with false fallthrough. Return unhandled presses to the shell so a race with sheet closure cannot swallow navigation.
    claimBack: (consumer: PageBackConsumer) => () => void
    notifyStorageWrite: (key: string, value: string | null) => boolean
    notifyHaptics: (kind: BridgeHapticsKind) => boolean
    // Never throw from error-boundary reporting. False means no frame left; shell load recovery covers reports that cannot be sent, without retrying this fault.
    notifyPageFault: (error: unknown) => boolean
    // After applying a one-shot param, ask its holder to clear that value (ruling 34). A failed clear is repaired when init delivers the still-held request again.
    clearRouteParam: (param: BridgeClearableRouteParam, value: string) => boolean
  }
