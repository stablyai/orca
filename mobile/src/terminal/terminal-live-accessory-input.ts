import type { TerminalLiveAccessoryInput } from './use-terminal-live-accessory-input-commit'

type TerminalLiveAccessoryKey = {
  readonly bytes: string
  readonly id: string
}

export function createTerminalLiveAccessoryInput(
  key: TerminalLiveAccessoryKey
): TerminalLiveAccessoryInput {
  if (key.id === 'backspace' || key.id === 'delete') {
    return { bytes: key.bytes, localEdit: key.id }
  }

  return { bytes: key.bytes }
}
