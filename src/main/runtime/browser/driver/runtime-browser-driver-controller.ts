import type { RuntimeTerminalDriverState } from '../../../../shared/runtime-session-contracts'

type RuntimeBrowserDriverControllerDeps = {
  notifyChanged: (browserPageId: string, next: RuntimeTerminalDriverState) => void
  cancelScreencast: (browserPageId: string) => void
}

export class RuntimeBrowserDriverController {
  private readonly drivers = new Map<string, RuntimeTerminalDriverState>()

  constructor(private readonly deps: RuntimeBrowserDriverControllerDeps) {}

  getAll(): Map<string, RuntimeTerminalDriverState> {
    return new Map(this.drivers)
  }

  get(browserPageId: string): RuntimeTerminalDriverState {
    return this.drivers.get(browserPageId) ?? { kind: 'idle' }
  }

  set(browserPageId: string, next: RuntimeTerminalDriverState): void {
    const prev = this.get(browserPageId)
    if (prev.kind === next.kind) {
      if (prev.kind === 'mobile' && next.kind === 'mobile' && prev.clientId === next.clientId) {
        return
      }
      if (prev.kind !== 'mobile' && next.kind !== 'mobile') {
        return
      }
    }
    if (next.kind === 'idle') {
      this.drivers.delete(browserPageId)
    } else {
      this.drivers.set(browserPageId, next)
    }
    this.deps.notifyChanged(browserPageId, next)
  }

  reclaimForDesktop(browserPageId: string): boolean {
    this.set(browserPageId, { kind: 'desktop' })
    this.deps.cancelScreencast(browserPageId)
    return true
  }
}
