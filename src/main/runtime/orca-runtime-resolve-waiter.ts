import { OrcaRuntimeWithResolveExitWaiters } from './terminal/wait/terminal-wait-settlements'
import type { TerminalWaiter } from './runtime-terminal-contracts'
import type { RuntimeTerminalWait } from '../../shared/runtime-terminal-contracts'
import type { BrowserWindow } from 'electron'
import { getRuntimeDesktopSurface } from './runtime-desktop-surface'

export abstract class OrcaRuntimeWithResolveWaiter extends OrcaRuntimeWithResolveExitWaiters {
  protected resolveWaiter(waiter: TerminalWaiter, result: RuntimeTerminalWait): void {
    this.terminalWaiters.resolve(waiter, result)
  }

  protected rejectAllWaiters(code: string): void {
    this.terminalWaiters.rejectAll(code)
  }

  protected removeWaiter(waiter: TerminalWaiter): void {
    this.terminalWaiters.remove(waiter)
  }

  protected getLeafKey(tabId: string, leafId: string): string {
    return `${tabId}::${leafId}`
  }

  getAuthoritativeWindow(missingWindowMessage = 'No renderer window available'): BrowserWindow {
    const win = this.getAvailableAuthoritativeWindow()
    if (!win || win.isDestroyed()) {
      throw new Error(missingWindowMessage)
    }
    return win
  }

  protected getAvailableAuthoritativeWindow(): BrowserWindow | null {
    if (this.authoritativeWindowId === null) {
      return null
    }
    const win = getRuntimeDesktopSurface().findWindowById(this.authoritativeWindowId)
    return win && !win.isDestroyed() ? win : null
  }
}
