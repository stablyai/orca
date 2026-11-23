export {}

// DOM compatibility patches are only needed after Vitest installs a DOM environment.
if (globalThis.document !== undefined) {
  await import('./happy-dom-offscreen-canvas')
  await import('./happy-dom-mutation-observer-retention')
  await import('./happy-dom-animation-cancel')
}
