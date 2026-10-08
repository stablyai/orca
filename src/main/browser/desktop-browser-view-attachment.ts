import type { BrowserWindow, View } from 'electron'
import type { DesktopBrowserViewLayout } from '../../shared/desktop-browser-view-protocol'
import type { DesktopOwnedBrowserViewRecord } from './desktop-owned-browser-view-admission'
import type { DesktopOwnedBrowserViewHost } from './desktop-owned-browser-view'
import { getDesktopBrowserViewLayout } from './desktop-browser-view-layout'

export class DesktopBrowserViewAttachment {
  readonly host: DesktopOwnedBrowserViewHost

  constructor(
    private readonly record: DesktopOwnedBrowserViewRecord,
    private readonly owner: BrowserWindow,
    readonly container: View
  ) {
    this.host = {
      isDestroyed: () => owner.isDestroyed() || !owner.contentView.children.includes(container),
      contentView: container
    }
  }

  attach(): void {
    const { record, owner, container } = this
    record.view.setVisible(false)
    record.view.setBounds({ x: 0, y: 0, width: 1, height: 1 })
    container.setVisible(false)
    container.setBounds({ x: 0, y: 0, width: 1, height: 1 })
    owner.contentView.addChildView(container)
    container.addChildView(record.view)
  }

  update(layout: DesktopBrowserViewLayout, scale: number): boolean {
    const { container, content, visible } = getDesktopBrowserViewLayout(
      layout,
      this.owner.getContentBounds(),
      scale
    )
    this.container.setBounds(container)
    this.record.view.setBounds(content)
    this.record.view.setVisible(visible)
    this.container.setVisible(visible)
    return visible
  }

  detach(): void {
    if (this.container.children.includes(this.record.view)) {
      this.container.removeChildView(this.record.view)
    }
    if (!this.owner.isDestroyed() && this.owner.contentView.children.includes(this.container)) {
      this.owner.contentView.removeChildView(this.container)
    }
  }
}
