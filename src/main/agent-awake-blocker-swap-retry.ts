export const AGENT_AWAKE_BLOCKER_SWAP_RETRY_MS = 1_000

type AgentAwakeBlockerType = 'prevent-app-suspension' | 'prevent-display-sleep'

export class AgentAwakeBlockerSwapRetry {
  private target: AgentAwakeBlockerType | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly retry: () => void) {}

  schedule(target: AgentAwakeBlockerType): void {
    if (this.target === target) {
      return
    }
    this.clear()
    this.target = target
    // Why: one prompt retry recovers a transient Electron stop failure without
    // turning a quiet-agent power transition into a polling loop.
    this.timer = setTimeout(() => {
      this.timer = null
      this.retry()
    }, AGENT_AWAKE_BLOCKER_SWAP_RETRY_MS)
    if (typeof this.timer.unref === 'function') {
      this.timer.unref()
    }
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.target = null
  }
}
