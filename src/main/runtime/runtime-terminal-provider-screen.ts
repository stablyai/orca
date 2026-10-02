import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

export type TuiIdleProviderScreenVersion = {
  record: RuntimePtyWorktreeRecord
  incarnationId: RuntimePtyWorktreeRecord['incarnationId']
  generation: number
  sequence: number
}

export type TuiIdleProviderScreen = {
  lines: readonly string[]
  isCurrent(): boolean
}

export type ProviderScreenDependencies = {
  getProviderScreenVersion?(ptyId: string): TuiIdleProviderScreenVersion | null
  readProviderScreen?(ptyId: string): Promise<TuiIdleProviderScreen | null>
}

export function sameProviderScreenOwner(
  left: TuiIdleProviderScreenVersion,
  right: TuiIdleProviderScreenVersion
): boolean {
  return (
    left.record === right.record &&
    left.incarnationId === right.incarnationId &&
    left.generation === right.generation
  )
}

/** One acquisition per quiet output version, shared with other readers by the runtime. */
export class RuntimeTerminalProviderScreen {
  private readonly owner: TuiIdleProviderScreenVersion | null
  private acquisition: {
    version: TuiIdleProviderScreenVersion
    promise: Promise<TuiIdleProviderScreen | null>
  } | null = null

  constructor(
    private readonly deps: ProviderScreenDependencies,
    private readonly ptyId: string | null
  ) {
    this.owner = ptyId ? (deps.getProviderScreenVersion?.(ptyId) ?? null) : null
  }

  get available(): boolean {
    return this.owner !== null && this.deps.readProviderScreen !== undefined
  }

  isCurrent(): boolean {
    if (!this.ptyId || !this.deps.getProviderScreenVersion) {
      return true
    }
    const live = this.deps.getProviderScreenVersion(this.ptyId)
    return this.owner !== null && live !== null && sameProviderScreenOwner(this.owner, live)
  }

  captureVersion(): () => boolean {
    const ptyId = this.ptyId
    const readVersion = this.deps.getProviderScreenVersion
    if (!ptyId || !readVersion) {
      return () => this.isCurrent()
    }
    const version = readVersion(ptyId)
    return () => {
      const live = readVersion(ptyId)
      return (
        this.isCurrent() &&
        version !== null &&
        live !== null &&
        sameProviderScreenOwner(version, live) &&
        version.sequence === live.sequence
      )
    }
  }

  read(): Promise<TuiIdleProviderScreen | null> | null {
    if (!this.ptyId || !this.deps.readProviderScreen || !this.isCurrent()) {
      return null
    }
    const version = this.deps.getProviderScreenVersion?.(this.ptyId)
    if (!version) {
      return null
    }
    if (
      !this.acquisition ||
      !sameProviderScreenOwner(this.acquisition.version, version) ||
      this.acquisition.version.sequence !== version.sequence
    ) {
      this.acquisition = { version, promise: this.deps.readProviderScreen(this.ptyId) }
    }
    return this.acquisition.promise
  }
}
