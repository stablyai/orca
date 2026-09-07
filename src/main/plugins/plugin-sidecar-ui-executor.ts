import type { PluginSidecarStoredFrame } from '../../shared/plugins/plugin-sidecar-contract'

export type SidecarUiExecutorApplyResult = {
  applied: boolean
  discordIpc: 'not-implemented'
  frame: PluginSidecarStoredFrame | null
}

/**
 * UI-machine insertion point for a later Discord IPC writer. This spike stores
 * the last applied frame only — it does not open pipes or sockets.
 */
export class PluginSidecarUiExecutor {
  private readonly lastBySlot = new Map<string, PluginSidecarStoredFrame>()

  apply(frame: PluginSidecarStoredFrame): SidecarUiExecutorApplyResult {
    const slot = `${frame.pluginKey}\0${frame.channel}`
    if (frame.op === 'clear') {
      this.lastBySlot.delete(slot)
      return { applied: true, discordIpc: 'not-implemented', frame: null }
    }
    this.lastBySlot.set(slot, frame)
    return { applied: true, discordIpc: 'not-implemented', frame }
  }

  last(
    pluginKey: string,
    channel: PluginSidecarStoredFrame['channel']
  ): PluginSidecarStoredFrame | null {
    return this.lastBySlot.get(`${pluginKey}\0${channel}`) ?? null
  }
}

export function applySidecarFrameOnUiMachine(
  executor: PluginSidecarUiExecutor,
  frame: PluginSidecarStoredFrame
): SidecarUiExecutorApplyResult {
  return executor.apply(frame)
}
