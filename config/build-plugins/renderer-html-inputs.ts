import { resolve } from 'node:path'

// Why: each pop-out surface gets its own HTML/React root sharing the preload API; keep index here,
// because overriding rollup input drops electron-vite's default entry.
export const RENDERER_HTML_INPUTS = {
  index: resolve('src/renderer/index.html'),
  popout: resolve('src/renderer/popout.html'),
  space: resolve('src/renderer/space.html'),
  // Built on every platform but only ever loaded on macOS, so the darwin gate lives
  // in main rather than in the build graph.
  notch: resolve('src/renderer/notch.html'),
  web: resolve('src/renderer/web-index.html')
}
