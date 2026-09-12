import { parsePairingCode } from '../../shared/pairing'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/protocol-version'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'

export function bindOrcadCapturedRuntimeRequest(options: {
  pairingCode: string
  runtimeId: string
  signal: AbortSignal
  timeoutMs?: number
  errorPrefix: string
  assertAuthority?: () => void
}) {
  options.signal.throwIfAborted()
  const pairing = parsePairingCode(options.pairingCode)
  if (!pairing) {
    throw new Error('orcad_migration_pairing_code_invalid')
  }
  const timeoutMs = options.timeoutMs ?? 15_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new Error(`${options.errorPrefix}_timeout_invalid`)
  }
  const assertCurrent = () => {
    options.signal.throwIfAborted()
    options.assertAuthority?.()
  }
  return async (method: string, params: Record<string, unknown>) => {
    assertCurrent()
    const response = await sendRemoteRuntimeRequest<unknown>(
      pairing,
      method,
      params,
      timeoutMs,
      undefined,
      options.signal,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )
    assertCurrent()
    if (!response.ok) {
      throw new Error(`${options.errorPrefix}_failed:${response.error.code}`)
    }
    if (response._meta.runtimeId !== options.runtimeId) {
      throw new Error(`${options.errorPrefix}_runtime_mismatch`)
    }
    return response.result
  }
}
