import type { TerminalQuickCommandMutation } from '../../../../shared/terminal/quick-commands/terminal-quick-commands'
import { applyTerminalQuickCommandMutation } from '../../../../shared/terminal/quick-commands/terminal-quick-commands'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { TerminalQuickCommand } from '../../../../shared/terminal/quick-commands/terminal-quick-command-types'

export function readRuntimeTerminalQuickCommands(
  store: Pick<RuntimeStore, 'getSettings'> | null
): TerminalQuickCommand[] {
  if (!store?.getSettings) {
    throw new Error('runtime_unavailable')
  }
  return store.getSettings().terminalQuickCommands ?? []
}

export function updateRuntimeTerminalQuickCommands(
  store: Pick<RuntimeStore, 'getSettings' | 'updateSettings'> | null,
  mutation: TerminalQuickCommandMutation
): TerminalQuickCommand[] {
  if (!store?.getSettings || !store.updateSettings) {
    throw new Error('runtime_unavailable')
  }
  const next = applyTerminalQuickCommandMutation(
    store.getSettings().terminalQuickCommands ?? [],
    mutation
  )
  store.updateSettings({ terminalQuickCommands: next }, { notifyListeners: true })
  return store.getSettings().terminalQuickCommands ?? []
}
