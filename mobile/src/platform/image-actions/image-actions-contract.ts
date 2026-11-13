import type { BridgeImageOperation } from '../../mobile-web-shell/bridge/bridge-image-verbs'

export type ImageAction = (operation: BridgeImageOperation) => Promise<void>

// Null for images with no bytes the phone can act on (SVG, unknown sources).
export type ImageActionsFor = (uri: string) => ImageAction | null

// Refusals the user can act on, so the viewer names them instead of a generic failure.
export type ImageActionRefusal = 'photos-access-denied' | 'too-large'

export class ImageActionRefusedError extends Error {
  readonly reason: ImageActionRefusal

  constructor(reason: ImageActionRefusal, message: string) {
    super(message)
    this.name = 'ImageActionRefusedError'
    this.reason = reason
  }
}
