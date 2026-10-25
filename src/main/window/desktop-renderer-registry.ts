import type { WebContents } from 'electron'

const renderers = new Map<number, WebContents>()
const rendererIds = new WeakMap<WebContents, number>()
const windowIds = new WeakMap<WebContents, string>()
let focusedRenderer: (() => WebContents | null) | null = null

export function setDesktopRendererFocusResolver(resolve: (() => WebContents | null) | null): void {
  focusedRenderer = resolve
}

export function registerDesktopRenderer(renderer: WebContents, windowId?: string): void {
  if (windowId) {
    windowIds.set(renderer, windowId)
  }
  if (rendererIds.has(renderer)) {
    return
  }
  rendererIds.set(renderer, renderer.id)
  renderers.set(renderer.id, renderer)
  renderer.on('destroyed', () => unregisterDesktopRenderer(renderer))
}

export function unregisterDesktopRenderer(renderer: WebContents): void {
  const id = rendererIds.get(renderer)
  if (id !== undefined && renderers.get(id) === renderer) {
    renderers.delete(id)
  }
  rendererIds.delete(renderer)
  windowIds.delete(renderer)
}

export function desktopWindowId(renderer?: WebContents): string | null {
  return renderer ? (windowIds.get(renderer) ?? null) : null
}

export function isRegisteredDesktopRenderer(renderer: WebContents): boolean {
  return (
    !renderer.isDestroyed() &&
    renderers.get(renderer.id) === renderer &&
    renderer.getType() === 'window'
  )
}

export function listDesktopRenderers(excludedId?: number): WebContents[] {
  return [...renderers.values()].filter(
    (renderer) => isRegisteredDesktopRenderer(renderer) && renderer.id !== excludedId
  )
}

export function broadcastDesktopRendererEvent(channel: string, ...values: unknown[]): number {
  let sent = 0
  for (const renderer of listDesktopRenderers()) {
    try {
      renderer.send(channel, ...values)
      sent += 1
    } catch {
      // Another window may already have committed its replacement document.
    }
  }
  return sent
}

export function preferredDesktopRenderer(excludedId?: number): WebContents | null {
  if (renderers.size === 0) {
    return null
  }
  const focused = focusedRenderer?.()
  if (focused && focused.id !== excludedId && isRegisteredDesktopRenderer(focused)) {
    return focused
  }
  return listDesktopRenderers(excludedId)[0] ?? null
}

export function isTrustedDesktopRenderer(
  renderer: WebContents,
  primaryRendererId: number | null,
  allowFileUrlFallback: boolean
): boolean {
  if (renderer.isDestroyed() || renderer.getType() !== 'window') {
    return false
  }
  if (renderers.size > 0) {
    return isRegisteredDesktopRenderer(renderer)
  }
  if (primaryRendererId !== null) {
    return renderer.id === primaryRendererId
  }
  const url = renderer.getURL()
  if (process.env.ELECTRON_RENDERER_URL) {
    try {
      return new URL(url).origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
    } catch {
      return false
    }
  }
  return allowFileUrlFallback && url.startsWith('file://')
}
