import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  getStructuredAgentSessionHost,
  onStructuredAgentSessionHostChanged
} from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { Binding } from './feishu-binding'
import type { FeishuStore } from './feishu-store-ops'
import { FeishuNativeProjection } from './feishu-native-projection'
import { FlushController } from './upstream/flush-controller'

type NativeLane = {
  external: string
  projection: FeishuNativeProjection
  release?: () => void
  flush: FlushController
}
export class FeishuNativeFeed {
  private readonly lanes = new Map<string, NativeLane>()
  constructor(
    private readonly runtime: OrcaRuntimeService,
    private readonly store: FeishuStore,
    private readonly b: Binding,
    private readonly signal: AbortSignal,
    private readonly active: () => boolean,
    private readonly wake: () => void
  ) {
    const stop = onStructuredAgentSessionHostChanged(() => {
      const external = [...this.lanes.values()].map((lane) => lane.external)
      this.clear()
      external.forEach((id) => this.track(id))
    })
    signal.addEventListener(
      'abort',
      () => {
        stop()
        this.clear()
      },
      { once: true }
    )
  }
  private clear(): void {
    for (const lane of this.lanes.values()) {
      lane.flush.complete()
      lane.flush.cancelPendingFlush()
      lane.release?.()
    }
    this.lanes.clear()
  }
  track(external: string): void {
    const host = getStructuredAgentSessionHost()
    const linked = this.runtime
      .getExternalConversationSeam()
      ?.linkedChat({ source: 'feishu-local', externalId: external }, this.b.bot)
    if (!host || !linked || this.lanes.has(linked.sessionId) || this.signal.aborted) {
      return
    }
    const projection = new FeishuNativeProjection()
    let last = ''
    const flush = new FlushController(async () => {
      try {
        if (!this.active() || this.signal.aborted) {
          return
        }
        const userId = projection.latest?.turn.userItemId
        if (userId && !projection.items.has(userId)) {
          const item = await host.historyItem(linked.sessionId, userId)
          if (item) {
            projection.items.set(item.itemId, item)
          }
        }
        const value = projection.project(this.b.account, external)
        if (!value) {
          return
        }
        const fingerprint = JSON.stringify(value)
        if (fingerprint === last) {
          return
        }
        const route = await this.store.messageRoute(this.b.account, value.original)
        if (
          !route ||
          route.external !== external ||
          this.lanes.get(linked.sessionId) !== lane ||
          getStructuredAgentSessionHost() !== host
        ) {
          return
        }
        await this.store.updateResponse(this.b.account, external, value.original, route.chat, {
          kind: 'native',
          value: value.native
        })
        last = fingerprint
        this.wake()
      } catch {
        this.wake()
      }
    })
    flush.setCardMessageReady(true)
    const lane: NativeLane = { external, projection, flush }
    this.lanes.set(linked.sessionId, lane)
    void host
      .subscribe({
        id: `feishu-cards:${this.b.account}:${external}`,
        sessionId: linked.sessionId,
        boundedFrames: true,
        commandsOnRequest: true,
        emit: (event) => {
          if (this.signal.aborted) {
            return
          }
          if (event.type === 'end') {
            if (this.lanes.get(linked.sessionId) === lane) {
              this.lanes.delete(linked.sessionId)
            }
            flush.complete()
            flush.cancelPendingFlush()
            return
          }
          projection.apply(event)
          void flush.throttledUpdate(300)
        }
      })
      .then((release) => {
        if (this.signal.aborted || this.lanes.get(linked.sessionId) !== lane) {
          release()
        } else {
          lane.release = release
        }
      })
      .catch(() => {
        if (this.lanes.get(linked.sessionId) === lane) {
          this.lanes.delete(linked.sessionId)
        }
        flush.complete()
        flush.cancelPendingFlush()
        this.wake()
      })
  }
  async flush(): Promise<void> {
    for (const lane of this.lanes.values()) {
      lane.flush.cancelPendingFlush()
      await lane.flush.waitForFlush()
      await lane.flush.flush()
    }
  }
}
