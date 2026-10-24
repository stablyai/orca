import type { BrowserWindow, WebContents } from 'electron'
import type { AutomationService } from '../automations/service'
import {
  desktopWindowId,
  listDesktopRenderers,
  preferredDesktopRenderer
} from './desktop-renderer-registry'

type NativeAutomationService = Pick<AutomationService, 'setWebContents'>
const readyByService = new WeakMap<NativeAutomationService, Set<WebContents>>()

export function attachNativeDesktopAutomations(
  service: NativeAutomationService,
  window: BrowserWindow
): boolean {
  if (!desktopWindowId(window.webContents)) {
    return false
  }
  const ready = readyByService.get(service) ?? new Set<WebContents>()
  if (!readyByService.has(service)) {
    readyByService.set(service, ready)
    const available = (): WebContents[] =>
      listDesktopRenderers().filter((renderer) => ready.has(renderer))
    service.setWebContents({
      isDestroyed: () => available().length === 0,
      send: (channel, ...args) => {
        const candidates = available()
        const preferred = preferredDesktopRenderer()
        const target = candidates.find((renderer) => renderer === preferred) ?? candidates[0]
        if (!target) {
          throw new Error('runtime_unavailable')
        }
        target.send(channel, ...args)
      }
    })
  }
  const renderer = window.webContents
  const forget = (): void => {
    ready.delete(renderer)
  }
  renderer.on('did-start-loading', () => {
    if (renderer.isLoadingMainFrame()) {
      forget()
    }
  })
  renderer.on('render-process-gone', forget)
  renderer.once('destroyed', forget)
  return true
}

export function markNativeDesktopAutomationReady(
  service: NativeAutomationService,
  renderer: WebContents
): void {
  if (desktopWindowId(renderer)) {
    readyByService.get(service)?.add(renderer)
  }
}
