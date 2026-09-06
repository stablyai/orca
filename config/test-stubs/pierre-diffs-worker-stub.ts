/**
 * Vitest cannot resolve Vite's `?worker` default export into a constructor, so
 * the real import throws when a diff surface mounts under test. Diff rendering
 * itself is validated in the app, not here — this stub only needs to construct.
 */
export default class PierreDiffsWorkerStub {
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}
