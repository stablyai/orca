// A URI RN <Image> can actually load: a local composer/echo preview (file://,
// data:, content://, blob:) or a real remote URL. A bare host path from the
// transcript (e.g. /tmp/x.png on an SSH host) is not loadable on the device, so
// it stays a text placeholder instead of a broken image.
const RENDERABLE_IMAGE_URI = /^(file:|data:|https?:|content:|blob:)/i

export function isRenderableImageUri(uri: string | undefined): uri is string {
  return typeof uri === 'string' && RENDERABLE_IMAGE_URI.test(uri)
}
