import type { RuntimeBrowserDriverState } from '../../shared/runtime-types'

type RuntimeBrowserDriverControllerDeps = {
  notifyChanged: (browserPageId: string, next: RuntimeBrowserDriverState) => void
  cancelScreencast: (browserPageId: string) => void
}

export class RuntimeBrowserDriverController {
  private readonly drivers = new Map<string, RuntimeBrowserDriverState>()

  constructor(private readonly deps: RuntimeBrowserDriverControllerDeps) {}

  getAll(): Map<string, RuntimeBrowserDriverState> {
    return new Map(this.drivers)
  }

  get(browserPageId: string): RuntimeBrowserDriverState {
    return this.drivers.get(browserPageId) ?? { kind: 'idle' }
  }

  set(browserPageId: string, next: RuntimeBrowserDriverState): void {
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
