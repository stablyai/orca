import type { RoomDelivery } from '../../../shared/rooms'

type RoomGateState = {
  tasks: Set<Promise<unknown>>
  active: FenceRequest | null
  queue: FenceRequest[]
}

type FenceRequest = {
  waitForTasks: boolean
  ready: Promise<boolean>
  resolve: (acquired: boolean) => void
  reject: (error: Error) => void
  settled: boolean
  released: boolean
}

export type RoomDeliveryFence = {
  ready: Promise<void>
  claimAllowed: () => boolean
  release: () => void
}

type RoomGateFence = {
  ready: Promise<boolean>
  claimAllowed: () => boolean
  release: () => void
}

export class RoomDeliveryGate {
  private readonly rooms = new Map<string, RoomGateState>()
  private disposed = false

  startTask<T>(roomId: string, run: () => Promise<T>): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('room_delivery_worker_disposed'))
    }
    const state = this.state(roomId)
    let task!: Promise<T>
    task = Promise.resolve()
      .then(run)
      .finally(() => {
        state.tasks.delete(task)
        this.cleanup(roomId, state)
      })
    state.tasks.add(task)
    return task
  }

  startClaim(
    roomId: string,
    claim: () => Promise<RoomDelivery[] | null>,
    startDelivery: (delivery: RoomDelivery) => void
  ): Promise<boolean> {
    return this.startTask(roomId, async () => {
      const deliveries = await claim()
      deliveries?.forEach(startDelivery)
      return Boolean(deliveries)
    })
  }

  requestFence(roomId: string, waitForTasks = true): RoomGateFence {
    if (this.disposed) {
      const ready = Promise.reject(new Error('room_delivery_worker_disposed'))
      void ready.catch(() => {})
      return { ready, claimAllowed: () => false, release: () => {} }
    }
    const state = this.state(roomId)
    let resolve!: (acquired: boolean) => void
    let reject!: (error: Error) => void
    const ready = new Promise<boolean>((done, fail) => {
      resolve = done
      reject = fail
    })
    void ready.catch(() => {})
    const request: FenceRequest = {
      waitForTasks,
      ready,
      resolve,
      reject,
      settled: false,
      released: false
    }
    state.queue.push(request)
    this.advance(roomId, state)
    return {
      ready,
      claimAllowed: () =>
        !this.disposed && state.active === request && request.settled && !request.released,
      release: () => this.release(roomId, state, request)
    }
  }

  claimAllowed(roomId: string): boolean {
    const state = this.rooms.get(roomId)
    return !this.disposed && !state?.active && !state?.queue.length
  }

  blockedRoomIds(): string[] {
    return [...this.rooms]
      .filter(([, state]) => Boolean(state.active || state.queue.length))
      .map(([roomId]) => roomId)
  }

  dispose(): void {
    this.disposed = true
    const error = new Error('room_delivery_worker_disposed')
    for (const [roomId, state] of this.rooms) {
      for (const request of [state.active, ...state.queue]) {
        if (request && !request.settled) {
          this.release(roomId, state, request, error)
        }
      }
    }
  }

  private state(roomId: string): RoomGateState {
    const state = this.rooms.get(roomId) ?? {
      tasks: new Set<Promise<unknown>>(),
      active: null,
      queue: []
    }
    this.rooms.set(roomId, state)
    return state
  }

  private advance(roomId: string, state: RoomGateState): void {
    if (this.disposed) {
      return this.cleanup(roomId, state)
    }
    if (state.active) {
      return
    }
    const request = state.queue.shift()
    if (!request) {
      return this.cleanup(roomId, state)
    }
    state.active = request
    void (request.waitForTasks ? this.waitForTasks(state) : Promise.resolve()).then(() => {
      if (!request.released) {
        request.settled = true
        request.resolve(true)
      }
    })
  }

  private async waitForTasks(state: RoomGateState): Promise<void> {
    while (state.tasks.size > 0) {
      await Promise.allSettled(state.tasks)
    }
  }

  private release(
    roomId: string,
    state: RoomGateState,
    request: FenceRequest,
    error?: Error
  ): void {
    if (request.released) {
      return
    }
    request.released = true
    if (!request.settled) {
      request.settled = true
      if (error) {
        request.reject(error)
      } else {
        request.resolve(false)
      }
    }
    if (state.active === request) {
      state.active = null
    } else {
      state.queue = state.queue.filter((candidate) => candidate !== request)
    }
    this.advance(roomId, state)
  }

  private cleanup(roomId: string, state: RoomGateState): void {
    if (!state.active && state.queue.length === 0 && state.tasks.size === 0) {
      this.rooms.delete(roomId)
    }
  }
}
