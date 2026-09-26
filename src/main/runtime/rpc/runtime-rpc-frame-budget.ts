import { MAX_RECOVERY_DESCRIPTOR_BYTES } from '../../../shared/cross-machine-recovery-descriptor'

export const MAX_RUNTIME_RPC_MESSAGE_BYTES = 1024 * 1024
const RECOVERY_IMPORT_METHOD = 'crossMachineRecovery.import'
// Why: an import frame carries a whole recovery descriptor; the rest of its envelope keeps the normal allowance.
export const MAX_RECOVERY_IMPORT_MESSAGE_BYTES =
  MAX_RECOVERY_DESCRIPTOR_BYTES + MAX_RUNTIME_RPC_MESSAGE_BYTES
const FRAME_METHOD_SCAN_CHARS = 4096
const LEADING_METHOD_PATTERN = /^\s*\{[^{}[\]]*?"method"\s*:\s*"([^"\\]*)"/

export function runtimeRpcFrameByteBudget(framePrefix: string): number {
  const method = LEADING_METHOD_PATTERN.exec(framePrefix.slice(0, FRAME_METHOD_SCAN_CHARS))?.[1]
  return method === RECOVERY_IMPORT_METHOD
    ? MAX_RECOVERY_IMPORT_MESSAGE_BYTES
    : MAX_RUNTIME_RPC_MESSAGE_BYTES
}

export function isWithinRuntimeRpcFrameBudget(rawMessage: string, byteLength: number): boolean {
  if (byteLength <= MAX_RUNTIME_RPC_MESSAGE_BYTES) {
    return true
  }
  if (byteLength > MAX_RECOVERY_IMPORT_MESSAGE_BYTES) {
    return false
  }
  // Why: the prefix scan only sizes the buffer; a duplicate "method" key could otherwise
  // smuggle another method through with the import allowance.
  let parsed: unknown
  try {
    parsed = JSON.parse(rawMessage)
  } catch {
    return false
  }
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    'method' in parsed &&
    parsed.method === RECOVERY_IMPORT_METHOD
  )
}
