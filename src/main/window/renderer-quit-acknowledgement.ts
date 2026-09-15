import { QUIT_RENDERER_ACK_TIMEOUT_MS } from '../../shared/quit-teardown-deadline'

export class RendererQuitAcknowledgement {
  private requestId: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly onTimeout: () => void) {}

  arm(requestId: number): void {
    this.requestId = requestId
    if (this.timer) {
      return
    }
    this.timer = setTimeout(() => {
      this.clear()
      this.onTimeout()
    }, QUIT_RENDERER_ACK_TIMEOUT_MS)
    this.timer.unref?.()
  }

  acknowledge(requestId: number): void {
    if (this.requestId === requestId) {
      this.clear()
    }
  }

  clear(): void {
    this.requestId = null
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
