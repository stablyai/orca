import { PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_INPUT_BYTES } from '../../../shared/pty-ownership-transfer-destination-input'

export type DelegatedInputState = {
  epoch: number
  retiring: boolean
  entries: { inputId: string; data: string; phase: 'attempted' | 'applied' | 'settled' }[]
}
export type DelegatedInputTransition = { epoch: number } & (
  | { kind: 'attempt'; inputId: string; data: string }
  | { kind: 'applied' | 'settled'; inputId: string }
  | { kind: 'begin-retirement' }
  | { kind: 'complete-retirement' }
)

export function parseDelegatedInputState(value: unknown, maximum: number): DelegatedInputState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('delegated_input_state_invalid')
  }
  const record = value as DelegatedInputState
  if (
    !Number.isSafeInteger(record.epoch) ||
    record.epoch < 0 ||
    typeof record.retiring !== 'boolean' ||
    !Array.isArray(record.entries) ||
    record.entries.length > maximum
  ) {
    throw new Error('delegated_input_state_invalid')
  }
  const ids = new Set<string>()
  for (const entry of record.entries) {
    if (
      !entry ||
      typeof entry.inputId !== 'string' ||
      !entry.inputId ||
      entry.inputId.length > 256 ||
      ids.has(entry.inputId) ||
      typeof entry.data !== 'string' ||
      !['attempted', 'applied', 'settled'].includes(entry.phase) ||
      (record.retiring && entry.phase !== 'settled')
    ) {
      throw new Error('delegated_input_state_invalid')
    }
    ids.add(entry.inputId)
  }
  if (
    (record.retiring && record.entries.length === 0) ||
    Buffer.byteLength(JSON.stringify(record), 'utf8') >
      PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_DURABLE_INPUT_BYTES
  ) {
    throw new Error('delegated_input_state_capacity')
  }
  return {
    epoch: record.epoch,
    retiring: record.retiring,
    entries: record.entries.map(({ inputId, data, phase }) => ({ inputId, data, phase }))
  }
}

export function transitionDelegatedInputState(
  previous: DelegatedInputState | undefined,
  command: DelegatedInputTransition,
  maximum: number
): DelegatedInputState {
  const state = parseDelegatedInputState(
    previous ?? { epoch: 0, retiring: false, entries: [] },
    maximum
  )
  if (!Number.isSafeInteger(command.epoch) || command.epoch < 0 || command.epoch !== state.epoch) {
    throw new Error('delegated_input_epoch_conflict')
  }
  if (command.kind === 'begin-retirement') {
    if (!state.entries.length || state.entries.some((entry) => entry.phase !== 'settled')) {
      throw new Error('delegated_input_retirement_unsettled')
    }
    state.retiring = true
  } else if (command.kind === 'complete-retirement') {
    if (!state.retiring || state.epoch === Number.MAX_SAFE_INTEGER) {
      throw new Error('delegated_input_retirement_unavailable')
    }
    state.epoch++
    state.retiring = false
    state.entries = []
  } else {
    if (state.retiring) {
      throw new Error('delegated_input_retirement_in_progress')
    }
    const entry = state.entries.find((entry) => entry.inputId === command.inputId)
    if (command.kind === 'attempt') {
      if (entry && entry.data !== command.data) {
        throw new Error('delegated_input_payload_conflict')
      }
      if (!entry) {
        state.entries.push({ inputId: command.inputId, data: command.data, phase: 'attempted' })
      }
    } else {
      if (!entry || (command.kind === 'settled' && entry.phase === 'attempted')) {
        throw new Error('delegated_input_settlement_unproven')
      }
      if (entry.phase !== 'settled') {
        entry.phase = command.kind
      }
    }
  }
  return parseDelegatedInputState(state, maximum)
}
