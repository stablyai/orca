/** Demo animations live under the docs zone as GIF + MP4 + JPG poster. */
const DOCS_MEDIA_ROOT = '/docs'
export function posterFor(src) {
  const name = src
    .split('/')
    .pop()
    .replace(/\.gif$/, '.jpg')
  return `${DOCS_MEDIA_ROOT}/posters/${name}`
}

export function videoFor(src) {
  const name = src
    .split('/')
    .pop()
    .replace(/\.gif$/, '.mp4')
  return `${DOCS_MEDIA_ROOT}/videos/${name}`
}
