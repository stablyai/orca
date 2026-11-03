import { EventEmitter } from 'node:events'
import type { BrowserPopupEvent } from '../../shared/browser-guest-events'

/** Facts the browser manager resolves to their owning page: a tab it asked for, a popup outcome, a download. */
export type BrowserPageEvent =
  | { kind: 'tab'; url: string }
  | {
      kind: 'popup'
      action: Exclude<BrowserPopupEvent['action'], 'opened-in-orca'> | 'window'
      origin: string
    }
  | { kind: 'download'; filename: string; origin: string }

/** Keyed by browser page id. */
export class BrowserPageEvents {
  private readonly emitter = new EventEmitter().setMaxListeners(0)

  observe(browserPageId: string, listener: (event: BrowserPageEvent) => void): () => void {
    this.emitter.on(browserPageId, listener)
    return () => this.emitter.off(browserPageId, listener)
  }

  emit(browserPageId: string, event: BrowserPageEvent): void {
    this.emitter.emit(browserPageId, event)
  }
}
