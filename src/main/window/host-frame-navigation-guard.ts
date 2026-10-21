import type { WebContents, WebFrameMain } from 'electron'
import { NATIVE_CHAT_VISUAL_FRAME_NAME_PREFIX } from '../../shared/native-chat-visual-shell'
import { PLUGIN_PANEL_FRAME_NAME_PREFIX } from '../../shared/plugins/plugin-panel-bridge'

type NavigationFrame = Pick<WebFrameMain, 'frameTreeNodeId' | 'isDestroyed' | 'name'>

/**
 * Host-built srcdoc frames that hold content Orca did not write. Each kind is only a navigation
 * containment class: registering a frame grants it nothing (no plugin identity, no actions).
 */
const HOST_FRAME_KINDS = [
  { kind: 'plugin-panel', namePrefix: PLUGIN_PANEL_FRAME_NAME_PREFIX },
  { kind: 'chat-visual', namePrefix: NATIVE_CHAT_VISUAL_FRAME_NAME_PREFIX }
] as const

export type HostFrameKind = (typeof HOST_FRAME_KINDS)[number]['kind']

type RegisteredFrame = {
  frame: NavigationFrame
  kind: HostFrameKind
  initialSrcdocPending: boolean
}

export function hostFrameKindForName(name: string): HostFrameKind | null {
  return HOST_FRAME_KINDS.find((entry) => name.startsWith(entry.namePrefix))?.kind ?? null
}

/** Records host-marked frame identities at browsing-context creation, before their content can
 * mutate window.name. */
export class HostFrameNavigationRegistry {
  private readonly frames = new Map<number, RegisteredFrame>()

  register(frame: NavigationFrame): void {
    this.prune()
    const kind = hostFrameKindForName(frame.name)
    if (kind) {
      this.frames.set(frame.frameTreeNodeId, { frame, kind, initialSrcdocPending: true })
    }
  }

  shouldBlock(
    frame: NavigationFrame | null,
    initiator: NavigationFrame | null,
    destinationUrl: string
  ): boolean {
    this.prune()
    const registeredTarget = frame ? this.frames.get(frame.frameTreeNodeId) : undefined
    if (registeredTarget) {
      // Why: registration happens before the host-provided srcdoc commits;
      // allow exactly that initial document, then contain every navigation.
      if (registeredTarget.initialSrcdocPending && destinationUrl === 'about:srcdoc') {
        registeredTarget.initialSrcdocPending = false
        return false
      }
      return true
    }
    return Boolean(initiator && this.frames.has(initiator.frameTreeNodeId))
  }

  clear(): void {
    this.frames.clear()
  }

  private prune(): void {
    for (const [id, registered] of this.frames) {
      if (registered.frame.isDestroyed()) {
        this.frames.delete(id)
      }
    }
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
      // Some Chromium builds populate the frame name only when navigation
      // starts; this event still precedes document parsing and frame content.
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
