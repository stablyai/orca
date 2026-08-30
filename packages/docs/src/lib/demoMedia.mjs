/**
 * Demo animations live as GIF + smaller MP4 + JPG poster.
 * GIF src may be under /docs/ or /whats-new/; poster/video always share
 * basename under /whats-new/ (same layout as marketing site encodes).
 */
export function posterFor(src) {
  const name = src
    .split('/')
    .pop()
    .replace(/\.gif$/, '.jpg')
  return `/whats-new/posters/${name}`
}

export function videoFor(src) {
  const name = src
    .split('/')
    .pop()
    .replace(/\.gif$/, '.mp4')
  return `/whats-new/videos/${name}`
}
