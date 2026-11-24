import type { DesktopMobileE2EEV2Session } from './mobile-e2ee-v2-desktop-session'

export function handleDesktopMobileE2EEV2Inbound(args: {
  session: DesktopMobileE2EEV2Session
  raw: string | Uint8Array<ArrayBufferLike>
  awaitingAuth: boolean
  onDecryptFailure: () => void
  onDecryptSuccess: () => void
  onAuth: (plaintext: string) => void
  onBinary: (plaintext: Uint8Array<ArrayBufferLike>) => void
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
    args.onText(plaintext)
  } else {
    args.onBinary(plaintext)
  }
}
