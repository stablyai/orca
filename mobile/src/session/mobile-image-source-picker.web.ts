export type MobileImageSource = 'library' | 'files'

export type PickedMobileImage = {
  readonly base64: string
  readonly uri?: string
}

export class ImageLibraryPermissionError extends Error {
  constructor() {
    super('Photo library permission denied')
    this.name = 'ImageLibraryPermissionError'
  }
}

export function pickMobileImage(_source: MobileImageSource): Promise<never> {
  return Promise.reject(new Error('Native image picker is unavailable'))
}
