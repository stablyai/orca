type RendererPrepareState = {
  epoch: number
  pending: number
}

export type BrowserRouteRendererPrepareFence = Readonly<{
  assertCurrent: () => void
  release: () => void
}>

export class BrowserRouteRendererPrepareFenceRegistry {
  private readonly states = new Map<number, RendererPrepareState>()

  begin(rendererWebContentsId: number): BrowserRouteRendererPrepareFence {
    const state = this.states.get(rendererWebContentsId) ?? { epoch: 0, pending: 0 }
    state.pending += 1
    this.states.set(rendererWebContentsId, state)
    const epoch = state.epoch
    let released = false
    return {
      assertCurrent: () => {
        if (state.epoch !== epoch) {
          throw new Error('browser_route_partition_renderer_retired')
        }
      },
      release: () => {
        if (released) {
          return
        }
        released = true
        state.pending -= 1
        if (state.pending === 0 && this.states.get(rendererWebContentsId) === state) {
          this.states.delete(rendererWebContentsId)
        }
      }
    }
  }

  retire(rendererWebContentsId: number): void {
    const state = this.states.get(rendererWebContentsId)
    if (state) {
      state.epoch += 1
    }
  }
}
