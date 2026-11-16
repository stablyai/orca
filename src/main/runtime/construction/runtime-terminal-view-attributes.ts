import { registerTerminalViewAttributesApplier } from '../terminal/view/terminal-view-attribute-store'
import type { RuntimeHeadlessTerminal } from '../terminal/records/runtime-terminal-state-records'

export function installRuntimeTerminalViewAttributes(
  read: () => Iterable<Pick<RuntimeHeadlessTerminal, 'emulator'>>
): void {
  registerTerminalViewAttributesApplier((attributes) => {
    for (const state of read()) {
      state.emulator.applyPushedViewAttributes(attributes)
    }
  })
}
