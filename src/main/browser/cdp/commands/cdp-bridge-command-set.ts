import type { WebContents } from 'electron'
import { CdpAuxiliaryCommands } from './cdp-auxiliary-commands'
import type { CdpTabState } from './cdp-tab-state'
import type { CdpCommandSender } from '../debugger/cdp-command-sender'
import type { CdpBridgeState } from './cdp-bridge-state'
import { CdpDebuggerLifecycle } from '../debugger/cdp-debugger-lifecycle'
import { CdpElementStateCommands } from './cdp-element-state-commands'
import { CdpNavigationOperations } from './cdp-navigation-operations'
import { CdpPageCommands } from './cdp-page-commands'
import { CdpPointerCommands } from '../input/cdp-pointer-commands'
import { CdpRefResolution } from './cdp-ref-resolution'
import { CdpTabCommands } from './cdp-tab-commands'
import { CdpTextInputCommands } from '../input/cdp-text-input-commands'

export class CdpBridgeCommandSet {
  readonly auxiliary: CdpAuxiliaryCommands
  readonly elements: CdpElementStateCommands
  readonly page: CdpPageCommands
  readonly pointer: CdpPointerCommands
  readonly tabs: CdpTabCommands
  readonly textInput: CdpTextInputCommands

  constructor(bridgeState: CdpBridgeState) {
    const debuggerLifecycle = new CdpDebuggerLifecycle(bridgeState)
    const navigation = new CdpNavigationOperations()
    const refResolution = new CdpRefResolution(bridgeState, debuggerLifecycle, navigation)

    this.elements = new CdpElementStateCommands(bridgeState, debuggerLifecycle, refResolution)
    this.page = new CdpPageCommands(bridgeState, debuggerLifecycle, navigation)
    this.pointer = new CdpPointerCommands(bridgeState, debuggerLifecycle, refResolution)
    this.tabs = new CdpTabCommands(bridgeState, debuggerLifecycle)
    this.textInput = new CdpTextInputCommands(bridgeState, debuggerLifecycle, refResolution)
    this.auxiliary = new CdpAuxiliaryCommands({
      run: <T>(
        operation: (context: {
          guest: WebContents
          sender: CdpCommandSender
          state: CdpTabState
        }) => Promise<T>
      ): Promise<T> =>
        bridgeState.enqueueCommand(async () => {
          const guest = bridgeState.getActiveGuest()
          const sender = debuggerLifecycle.makeCdpSender(guest)
          await debuggerLifecycle.ensureDebuggerAttached(guest)
          const state = bridgeState.getOrCreateTabState(bridgeState.resolveTabId(guest.id))
          return operation({ guest, sender, state })
        }),
      runOnState: <T>(
        operation: (context: { guest: WebContents; state: CdpTabState }) => Promise<T>
      ): Promise<T> =>
        bridgeState.enqueueCommand(async () => {
          const guest = bridgeState.getActiveGuest()
          const state = bridgeState.getOrCreateTabState(bridgeState.resolveTabId(guest.id))
          return operation({ guest, state })
        }),
      current: () => {
        const guest = bridgeState.getActiveGuest()
        return {
          guest,
          state: bridgeState.getOrCreateTabState(bridgeState.resolveTabId(guest.id))
        }
      }
    })
  }
}
