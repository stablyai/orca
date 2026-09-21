// Why: happy-dom exposes OffscreenCanvas without a default canvas adapter. xterm prefers that API
// and then cannot open in tests that already provide the HTML canvas text-metric stand-in.

const OFFSCREEN_CANVAS_COMPATIBILITY_INSTALLED = Symbol.for(
  'orca.happyDomOffscreenCanvasCompatibility'
)

type PatchableCanvas = {
  getContext?: (contextType: string, contextAttributes?: unknown) => unknown
} & Record<symbol, unknown>

type CanvasConstructor = {
  prototype: PatchableCanvas
  new (width: number, height: number): PatchableCanvas
}

type HappyDomGlobals = {
  OffscreenCanvas?: CanvasConstructor
  HTMLCanvasElement?: { prototype: PatchableCanvas }
  document?: Pick<Document, 'createElement'>
}

/** Make happy-dom's adapter-less OffscreenCanvas honor the existing HTML canvas test double. */
export function installHappyDomOffscreenCanvasCompatibility(): boolean {
  const globals = globalThis as unknown as HappyDomGlobals
  const offscreenCanvas = globals.OffscreenCanvas
  const htmlCanvas = globals.HTMLCanvasElement
  const document = globals.document
  if (!offscreenCanvas || !htmlCanvas || !document) {
    return false
  }

  const prototype = offscreenCanvas.prototype
  if (prototype[OFFSCREEN_CANVAS_COMPATIBILITY_INSTALLED] === true) {
    return true
  }
  const originalGetContext = prototype.getContext
  if (!originalGetContext || !htmlCanvas.prototype.getContext) {
    return false
  }

  prototype.getContext = function patchedGetContext(
    this: PatchableCanvas,
    contextType: string,
    contextAttributes?: unknown
  ): unknown {
    const context = originalGetContext.call(this, contextType, contextAttributes)
    if (contextType !== '2d' || context) {
      return context
    }

    const canvas = document.createElement('canvas') as PatchableCanvas
    return htmlCanvas.prototype.getContext!.call(canvas, contextType, contextAttributes)
  }
  prototype[OFFSCREEN_CANVAS_COMPATIBILITY_INSTALLED] = true
  return true
}

installHappyDomOffscreenCanvasCompatibility()
