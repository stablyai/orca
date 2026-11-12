import { app, powerMonitor, type NativeImage } from 'electron'
import type {
  MenuBarAction,
  MenuBarItem,
  MenuBarQACommand,
  MenuBarSnapshot
} from './mac-menu-bar-protocol'
import { MacMenuBarProcess } from './mac-menu-bar-process'

export type TrayMenuItem = MenuBarItem & { click?: () => void }
let retirement: Promise<void> = Promise.resolve()

export function waitForMacMenuBarRetirement(): Promise<void> {
  return retirement
}

/** Image composition remains in main; only the native item/menu lives in the child. */
export class MacMenuBarTray {
  private readonly owner: MacMenuBarProcess
  private readonly predecessor = retirement
  private started = false
  private destroyed = false
  private image: NativeImage
  private tooltip = ''
  private menu: TrayMenuItem[] = []
  private readonly suspend = (): void => this.owner.suspend()
  private readonly resume = (): void => this.owner.resume()

  constructor(image: NativeImage, onCreated?: () => void) {
    this.image = image
    this.owner = new MacMenuBarProcess({
      qa: process.env.ORCA_E2E_MENU_BAR === '1' && Boolean(process.env.ORCA_E2E_USER_DATA_DIR),
      executable: app.isPackaged ? undefined : process.env.ORCA_DEV_MENU_BAR_EXECUTABLE,
      onCreated,
      onAction: (action: MenuBarAction) => this.menu.find((item) => item.id === action)?.click?.()
    })
    powerMonitor.on('suspend', this.suspend)
    powerMonitor.on('resume', this.resume)
    void this.predecessor.then(() => {
      if (this.destroyed) {
        return
      }
      this.started = true
      this.publish()
    })
  }

  setImage(image: NativeImage): void {
    this.image = image
    this.publish()
  }
  setToolTip(tooltip: string): void {
    this.tooltip = tooltip
    this.publish()
  }
  setMenu(menu: TrayMenuItem[]): void {
    this.menu = menu
    this.publish()
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  inspectForQA(command: MenuBarQACommand): Promise<unknown> {
    return this.owner.inspectForQA(command)
  }

  destroy(): Promise<void> {
    this.destroyed = true
    powerMonitor.off('suspend', this.suspend)
    powerMonitor.off('resume', this.resume)
    // Rapid off/on must join even a predecessor still awaiting observed exit.
    retirement = Promise.all([this.predecessor, this.owner.destroy()]).then(() => {})
    return retirement
  }

  private publish(): void {
    if (!this.started || this.destroyed) {
      return
    }
    const snapshot: MenuBarSnapshot = {
      images: [...new Set(this.image.getScaleFactors())].map((scale) => ({
        scale,
        png: this.image.toPNG({ scaleFactor: scale }).toString('base64')
      })),
      template: this.image.isTemplateImage(),
      tooltip: this.tooltip,
      menu: this.menu.map(({ click: _click, ...item }) => item)
    }
    this.owner.update(snapshot)
  }
}
