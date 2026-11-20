// Main-process dependencies compiled into the bundle instead of loaded from node_modules.
export const BUNDLED_MAIN_DEPENDENCIES = new Set([
  'stream-json',
  'stream-chain',
  '@xterm/headless',
  '@xterm/addon-serialize',
  'tldts',
  'smol-toml',
  'yaml',
  'fflate',
  'imagescript',
  'mime-types',
  'mime-db',
  // Linear save confirmation; bundled like orcad so packaging needs no extra node_modules.
  'unified',
  'remark-parse',
  'remark-gfm',
  'remark-cjk-friendly',
  'markdown-table',
  'hast-util-from-html-isomorphic',
  // Windows NSIS copies app.asar before external resources; bootstrap must not race resources/node_modules.
  'zod'
])
