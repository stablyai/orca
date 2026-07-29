import type { WebContents, WebFrameMain } from 'electron'
import { PLUGIN_PANEL_FRAME_NAME_PREFIX } from '../../shared/plugins/plugin-panel-bridge'

type NavigationFrame = Pick<WebFrameMain, 'frameTreeNodeId' | 'isDestroyed' | 'name'>

type RegisteredFrame = {
  frame: NavigationFrame
  initialSrcdocPending: boolean
}

/** Records host-marked panel frame identities at browsing-context creation,
 * before plugin parsing can mutate window.name. */
export class PluginPanelNavigationRegistry {
  private readonly frames = new Map<number, RegisteredFrame>()

  register(frame: NavigationFrame): void {
    this.prune()
    if (frame.name.startsWith(PLUGIN_PANEL_FRAME_NAME_PREFIX)) {
      this.frames.set(frame.frameTreeNodeId, { frame, initialSrcdocPending: true })
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

export function registerPluginPanelNavigationGuard(webContents: WebContents): void {
  const registry = new PluginPanelNavigationRegistry()
  webContents.on('frame-created', (_event, { frame }) => {
    if (frame) {
      registry.register(frame)
    }
  })
  webContents.on('did-start-navigation', (event) => {
    if (!event.isMainFrame && event.url === 'about:srcdoc' && event.frame) {
      // Some Chromium builds populate the frame name only when navigation
      // starts; this event still precedes document parsing and plugin code.
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
