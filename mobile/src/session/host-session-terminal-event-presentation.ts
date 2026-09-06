import type {
  HostSessionTerminalData,
  HostSessionTerminalOperations
} from './host-session-terminal-operations'

export function hostSessionTerminalData(value: unknown): HostSessionTerminalData {
  return typeof value === 'string' || value instanceof Uint8Array ? value : ''
}

export function hostSessionTerminalAcknowledgement(
  operations: HostSessionTerminalOperations,
  terminalId: string,
  throughSequence: unknown
): (() => void) | undefined {
  return typeof throughSequence === 'number'
    ? () => operations.acknowledge(terminalId, throughSequence)
    : undefined
}
