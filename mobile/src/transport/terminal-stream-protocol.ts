// Why: single source of truth lives in the repo-root shared module so desktop
// main/renderer and mobile decode the same wire format; this file only re-exports it.
export * from '../../../src/shared/terminal-stream-protocol'
