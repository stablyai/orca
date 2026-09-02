import type { RuntimeTerminalDriverState } from '../../shared/runtime-types'
import { notifyRuntimeListeners } from './runtime-async-boundaries'

type DriverState = RuntimeTerminalDriverState

type RuntimeTerminalDriverDependencies = {
  notifyChanged: (ptyId: string, next: DriverState) => void
  canClaimMobileFloor: (ptyId: string, clientId: string) => boolean
  commitMobileFloor: (
    ptyId: string,
    clientId: string,
    previousFloor: DriverState,
    isCurrent: () => boolean
  ) => Promise<void>
}

type MobileInputFloorState = {
  base: DriverState
  generation: number
  committedGeneration: number
  pending: Map<symbol, { clientId: string; generation: number }>
}

export class RuntimeTerminalDriverController {
  private readonly current = new Map<string, DriverState>()
  private readonly listeners = new Map<string, Set<(driver: DriverState) => void>>()
  private readonly inputFloorClaims = new Map<string, MobileInputFloorState>()

  constructor(private readonly deps: RuntimeTerminalDriverDependencies) {}

  get(ptyId: string): DriverState {
    return this.current.get(ptyId) ?? { kind: 'idle' }
  }

  getAll(): Map<string, DriverState> {
    return new Map(this.current)
  }

  set(ptyId: string, next: DriverState): void {
    const prev = this.get(ptyId)
    if (prev.kind === next.kind) {
      if (prev.kind === 'mobile' && next.kind === 'mobile' && prev.clientId === next.clientId) {
        return
      }
      if (prev.kind !== 'mobile' && next.kind !== 'mobile') {
        return
      }
    }
    if (next.kind === 'idle') {
      this.current.delete(ptyId)
    } else {
      this.current.set(ptyId, next)
    }
    this.deps.notifyChanged(ptyId, next)
    const listeners = this.listeners.get(ptyId)
    if (listeners) {
      notifyRuntimeListeners(listeners, (listener) => listener(next), 'pty-driver')
    }
  }

  clear(ptyId: string): boolean {
    if (!this.current.delete(ptyId)) {
      return false
    }
    this.deps.notifyChanged(ptyId, { kind: 'idle' })
    return true
  }

  subscribe(ptyId: string, listener: (driver: DriverState) => void): () => void {
    const listeners = this.listeners.get(ptyId) ?? new Set<(driver: DriverState) => void>()
    listeners.add(listener)
    this.listeners.set(ptyId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) {
        this.listeners.delete(ptyId)
      }
    }
  }

  beginMobileInputFloor(
    ptyId: string,
    clientId: string
  ): { commit: () => Promise<void>; rollback: () => void } | null {
    if (!this.deps.canClaimMobileFloor(ptyId, clientId)) {
      return null
    }
    const state = this.inputFloorClaims.get(ptyId) ?? {
      base: this.get(ptyId),
      generation: 0,
      committedGeneration: 0,
      pending: new Map<symbol, { clientId: string; generation: number }>()
    }
    this.inputFloorClaims.set(ptyId, state)
    const token = Symbol('mobile-input-floor')
    const generation = ++state.generation
    state.pending.set(token, { clientId, generation })
    this.set(ptyId, { kind: 'mobile', clientId })
    let settled = false
    return {
      commit: async () => {
        if (settled) {
          return
        }
        settled = true
        state.pending.delete(token)
        if (generation < state.committedGeneration) {
          this.deleteSettledClaim(ptyId, state)
          return
        }
        const previousFloor = state.base
        state.committedGeneration = generation
        state.base = { kind: 'mobile', clientId }
        await this.deps.commitMobileFloor(
          ptyId,
          clientId,
          previousFloor,
          () =>
            this.inputFloorClaims.get(ptyId) === state && state.committedGeneration === generation
        )
        this.deleteSettledClaim(ptyId, state)
      },
      rollback: () => {
        if (settled) {
          return
        }
        settled = true
        state.pending.delete(token)
        if (this.inputFloorClaims.get(ptyId) !== state) {
          return
        }
        const current = this.get(ptyId)
        if (current.kind === 'mobile' && current.clientId === clientId) {
          const pendingClientId = Array.from(state.pending.values()).at(-1)?.clientId
          this.set(
            ptyId,
            pendingClientId ? { kind: 'mobile', clientId: pendingClientId } : state.base
          )
        }
        this.deleteSettledClaim(ptyId, state)
      }
    }
  }

  private deleteSettledClaim(ptyId: string, state: MobileInputFloorState): void {
    if (state.pending.size === 0 && this.inputFloorClaims.get(ptyId) === state) {
      this.inputFloorClaims.delete(ptyId)
    }
  }
}
