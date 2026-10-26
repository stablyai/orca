// Accept device-loadable URI schemes only; a bare host/SSH path must remain a text placeholder.
const RENDERABLE_IMAGE_URI = /^(file:|data:|https?:|content:|blob:)/i

export function isRenderableImageUri(uri: string | undefined): uri is string {
  return typeof uri === 'string' && RENDERABLE_IMAGE_URI.test(uri)
}
