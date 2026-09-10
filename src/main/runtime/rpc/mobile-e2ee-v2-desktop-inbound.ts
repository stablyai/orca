import type { DesktopMobileE2EEV2Session } from './mobile-e2ee-v2-desktop-session'
import { parseRemoteRuntimeJsonText } from '../../../shared/remote-runtime-request-frames'

export function handleDesktopMobileE2EEV2Inbound(args: {
  session: DesktopMobileE2EEV2Session
  raw: string | Uint8Array<ArrayBufferLike>
  awaitingAuth: boolean
  onDecryptFailure: () => void
  onDecryptSuccess: () => void
  onAuth: (plaintext: string) => void
  onBinary: (plaintext: Uint8Array<ArrayBufferLike>) => void
  onRuntimeClientCapabilities: (value: unknown) => void
  onText: (plaintext: string) => void
  onProtocolError: () => void
}): void {
  const plaintext =
    typeof args.raw === 'string'
      ? args.session.openText(args.raw)
      : args.session.openBinary(args.raw)
  if (plaintext === null) {
    args.onDecryptFailure()
    return
  }
  args.onDecryptSuccess()
  if (args.awaitingAuth) {
    if (typeof plaintext !== 'string') {
      args.onProtocolError()
      return
    }
    args.onAuth(plaintext)
  } else if (typeof plaintext === 'string') {
    const capabilities = runtimeClientCapabilities(plaintext)
    if (capabilities === null) {
      args.onText(plaintext)
    } else {
      args.onRuntimeClientCapabilities(capabilities)
    }
  } else {
    args.onBinary(plaintext)
  }
}

function runtimeClientCapabilities(plaintext: string): unknown {
  let value: unknown
  try {
    value = parseRemoteRuntimeJsonText(plaintext)
  } catch {
    return null
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { type?: unknown }).type !== 'runtime_client_capabilities'
  ) {
    return null
  }
  return (value as { clientCapabilities?: unknown }).clientCapabilities ?? []
}
