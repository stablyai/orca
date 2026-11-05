import type { RuntimeCapability } from '../../../shared/protocol-version'

export function parseRuntimeClientCapabilities(value: unknown): readonly RuntimeCapability[] {
  if (!Array.isArray(value) || value.length > 64) {
    return []
  }
  const capabilities = value.filter(
    (capability): capability is RuntimeCapability =>
      typeof capability === 'string' && capability.length > 0 && capability.length <= 128
  )
  return capabilities.length === value.length ? capabilities : []
}

/** A connection owns support evidence; stream encodings still use their opening snapshot. */
export class RuntimeClientCapabilities {
  private capabilities: readonly RuntimeCapability[] = []
  private readonly observers = new Set<(previous: readonly RuntimeCapability[]) => void>()

  get current(): readonly RuntimeCapability[] {
    return this.capabilities
  }

  replace(value: unknown): void {
    const next = parseRuntimeClientCapabilities(value)
    if (
      new Set(next).size === new Set(this.capabilities).size &&
      next.every((capability) => this.capabilities.includes(capability))
    ) {
      return
    }
    const previous = this.capabilities
    this.capabilities = next
    for (const observer of this.observers) {
      try {
        observer(previous)
      } catch (error) {
        console.warn('[runtime] capability observer failed', error)
      }
    }
  }

  dispose(): void {
    this.observers.clear()
  }

  observe(observer: (previous: readonly RuntimeCapability[]) => void): () => void {
    this.observers.add(observer)
    return () => {
      this.observers.delete(observer)
    }
  }
}
