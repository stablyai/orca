import type { PairingRejection } from './pairing'

export type PairingInputSource = 'qr' | 'paste' | 'deep-link'

// Why: the user can't read our code, so every rejection names what to do next.
// The version case carries both numbers — that is the only signal that tells an
// out-of-date app apart from a bad paste.
export function pairingRejectionMessage(
  rejection: PairingRejection,
  source: PairingInputSource
): string {
  switch (rejection.reason) {
    case 'empty':
      return 'Enter the pairing code shown on your computer'
    case 'not-pairing-link':
      return source === 'qr'
        ? 'Not an Orca pairing QR code — scan the one under Settings → Mobile'
        : "That link isn't an Orca pairing link — copy it under Settings → Mobile"
    case 'missing-code':
      return 'That pairing link carries no code — copy the whole link from your computer'
    case 'malformed-code':
      return malformedCodeMessage(source)
    case 'unsupported-version':
      return `This pairing code is version ${rejection.offerVersion}, but this app only supports version ${rejection.supportedVersion}. Update Orca on your phone.`
    case 'invalid-offer':
      return 'That pairing code is not usable — generate a new one on your computer'
  }
}

function malformedCodeMessage(source: PairingInputSource): string {
  switch (source) {
    case 'qr':
      return "Couldn't read that QR code — hold steady and try again"
    case 'paste':
      return 'That pairing code looks incomplete — copy all of it and paste again'
    case 'deep-link':
      return 'That pairing link is damaged — generate a new code on your computer'
  }
}
