import type { WebContents, WebFrameMain } from 'electron'
import { NATIVE_CHAT_VISUAL_FRAME_NAME_PREFIX } from '../../shared/native-chat/native-chat-visual-shell'
import { PLUGIN_PANEL_FRAME_NAME_PREFIX } from '../../shared/plugins/frames/plugin-frame-bridge'

type NavigationFrame = Pick<WebFrameMain, 'frameTreeNodeId' | 'isDestroyed' | 'name'>

/** Host-marked srcdoc classes contain navigation only; registration grants no plugin identity or action authority. */
const HOST_FRAME_KINDS = [
  { kind: 'plugin-panel', namePrefix: PLUGIN_PANEL_FRAME_NAME_PREFIX },
  { kind: 'chat-visual', namePrefix: NATIVE_CHAT_VISUAL_FRAME_NAME_PREFIX }
] as const

export type HostFrameKind = (typeof HOST_FRAME_KINDS)[number]['kind']

type RegisteredFrame = {
  kind: HostFrameKind
  initialSrcdocPending: boolean
}

export function hostFrameKindForName(name: string): HostFrameKind | null {
  return HOST_FRAME_KINDS.find((entry) => name.startsWith(entry.namePrefix))?.kind ?? null
}

/** Records host-marked frame identities at browsing-context creation, before their content can
 * mutate window.name. */
export class HostFrameNavigationRegistry {
  private frames = new WeakMap<NavigationFrame, RegisteredFrame>()

  register(frame: NavigationFrame): void {
    const kind = hostFrameKindForName(frame.name)
    if (kind) {
      this.frames.set(frame, { kind, initialSrcdocPending: true })
    }
  }

  shouldBlock(
    frame: NavigationFrame | null,
    initiator: NavigationFrame | null,
    destinationUrl: string
  ): boolean {
    const registeredTarget = frame ? this.frames.get(frame) : undefined
    if (registeredTarget && frame && !frame.isDestroyed()) {
      // Registration precedes srcdoc commit; allow its initial document only, then contain all navigation.
      if (registeredTarget.initialSrcdocPending && destinationUrl === 'about:srcdoc') {
        registeredTarget.initialSrcdocPending = false
        return false
      }
      return true
    }
    return Boolean(initiator && this.frames.has(initiator) && !initiator.isDestroyed())
  }

  clear(): void {
    this.frames = new WeakMap()
  }
}

export function registerHostFrameNavigationGuard(webContents: WebContents): void {
  const registry = new HostFrameNavigationRegistry()
  webContents.on('frame-created', (_event, { frame }) => {
    if (frame) {
      registry.register(frame)
    }
  })
  webContents.on('did-start-navigation', (event) => {
    if (!event.isMainFrame && event.url === 'about:srcdoc' && event.frame) {
      // Some Chromium builds expose frame names only at navigation start, still before content parsing.
      registry.register(event.frame)
    }
  })
  webContents.on('will-frame-navigate', (event) => {
    if (registry.shouldBlock(event.frame, event.initiator ?? null, event.url)) {
      event.preventDefault()
    }
  })
  webContents.on('destroyed', () => registry.clear())
}
