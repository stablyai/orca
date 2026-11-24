export type ClaudeEchoedDispatch = { sentUuid: string; fence: number }

/** Only the turn opened by the echo can adopt a later lifecycle start. */
export class ClaudeEchoedDispatchStart {
  private dispatch: (ClaudeEchoedDispatch & { firstOutputAt?: number }) | null = null

  constructor(private readonly revise: (startedAt: number) => void) {}

  get awaitsFirstOutput(): boolean {
    return this.dispatch !== null && this.dispatch.firstOutputAt === undefined
  }

  expect(dispatch: ClaudeEchoedDispatch): void {
    this.dispatch = { ...dispatch }
  }

  observeOutput(observedAt: number | undefined): void {
    const dispatch = this.dispatch
    if (dispatch && dispatch.firstOutputAt === undefined) {
      dispatch.firstOutputAt = observedAt ?? Date.now()
    }
  }

  confirm(sentUuid: string | null, fence: number, observedAt: number): void {
    const dispatch = this.dispatch
    if (dispatch?.sentUuid !== sentUuid || dispatch.fence !== fence) {
      return
    }
    this.clear()
    this.revise(Math.min(observedAt, dispatch.firstOutputAt ?? observedAt))
  }

  clear(): void {
    this.dispatch = null
  }
}
