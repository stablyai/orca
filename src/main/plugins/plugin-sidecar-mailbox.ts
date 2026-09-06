import {
  PLUGIN_SIDECAR_MAILBOX_SLOT_LIMIT,
  buildSidecarPlacement,
  type PluginSidecarPlacement,
  type PluginSidecarPublishParams,
  type PluginSidecarPublishResult,
  type PluginSidecarStoredFrame
} from '../../shared/plugins/plugin-sidecar-contract'

function mailboxKey(pluginKey: string, channel: PluginSidecarStoredFrame['channel']): string {
  return `${pluginKey}\0${channel}`
}

type SidecarMailboxSlot = {
  frame: PluginSidecarStoredFrame
  sequence: number
}

/** Process-local last-frame store shared by plugin host calls and runtime RPC. */
export class PluginSidecarMailbox {
  private readonly frames = new Map<string, SidecarMailboxSlot>()
  private publishSequence = 0

  resolvePlacement(pluginKey?: string): PluginSidecarPlacement {
    return buildSidecarPlacement(this.lastPublishedAt(pluginKey))
  }

  publish(pluginKey: string, input: PluginSidecarPublishParams): PluginSidecarPublishResult {
    const publishedAt = Date.now()
    this.publishSequence += 1
    const frame: PluginSidecarStoredFrame = {
      pluginKey,
      channel: input.channel,
      op: input.op,
      payload: input.op === 'clear' ? null : (input.payload ?? null),
      publishedAt
    }
    this.frames.set(mailboxKey(pluginKey, input.channel), {
      frame,
      sequence: this.publishSequence
    })
    this.evictOldestIfNeeded()
    return {
      accepted: true,
      delivery: 'stored',
      placement: buildSidecarPlacement(publishedAt)
    }
  }

  latest(pluginKey?: string): PluginSidecarStoredFrame[] {
    const frames = [...this.frames.values()]
      .sort((left, right) => {
        if (left.frame.publishedAt !== right.frame.publishedAt) {
          return left.frame.publishedAt - right.frame.publishedAt
        }
        return left.sequence - right.sequence
      })
      .map((slot) => slot.frame)
    if (!pluginKey) {
      return frames
    }
    return frames.filter((frame) => frame.pluginKey === pluginKey)
  }

  private lastPublishedAt(pluginKey?: string): number | null {
    const frames = this.latest(pluginKey)
    if (frames.length === 0) {
      return null
    }
    return frames.at(-1)!.publishedAt
  }

  private evictOldestIfNeeded(): void {
    while (this.frames.size > PLUGIN_SIDECAR_MAILBOX_SLOT_LIMIT) {
      const oldest = this.latest()[0]
      if (!oldest) {
        return
      }
      this.frames.delete(mailboxKey(oldest.pluginKey, oldest.channel))
    }
  }
}
