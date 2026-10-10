import type { PanelLiveMessageDelivery } from '../../shared/plugins/plugin-panel-bridge'
import type { PluginPanelSessionBinding } from './plugin-panel-sessions'

export type PluginPanelMount = {
  ownerKey: string
  sessionToken: string
  binding: PluginPanelSessionBinding
  deliver: (delivery: PanelLiveMessageDelivery) => void
}

type MountRecord = PluginPanelMount & { count: number }

/** Panel frames currently mounted per session, so worker pushes reach only
 *  live frames of the owning plugin and are dropped otherwise. Ref-counted:
 *  one window can mount the same panel session more than once. */
export class PluginPanelMounts {
  private readonly mounts = new Map<string, MountRecord>()

  attach(mount: PluginPanelMount): void {
    const existing = this.mounts.get(mount.sessionToken)
    if (existing && existing.ownerKey === mount.ownerKey) {
      existing.count += 1
      return
    }
    this.mounts.set(mount.sessionToken, { ...mount, count: 1 })
  }

  detach(ownerKey: string, sessionToken: string): void {
    const existing = this.mounts.get(sessionToken)
    if (!existing || existing.ownerKey !== ownerKey) {
      return
    }
    existing.count -= 1
    if (existing.count <= 0) {
      this.mounts.delete(sessionToken)
    }
  }

  forPanel(pluginKey: string, panelId: string): PluginPanelMount[] {
    return [...this.mounts.values()].filter(
      (mount) => mount.binding.pluginKey === pluginKey && mount.binding.panelId === panelId
    )
  }

  delete(sessionToken: string): void {
    this.mounts.delete(sessionToken)
  }

  revokeOwner(ownerKey: string): void {
    for (const [sessionToken, mount] of this.mounts) {
      if (mount.ownerKey === ownerKey) {
        this.mounts.delete(sessionToken)
      }
    }
  }

  clear(): void {
    this.mounts.clear()
  }
}
