import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type {
  installStructuredAgentAvailability,
  StructuredAgentAvailabilityReader
} from './structured-agent-availability'

type AvailabilityRuntime = Parameters<typeof installStructuredAgentAvailability>[1]
type AvailabilityHandle = ReturnType<typeof installStructuredAgentAvailability>

export class LazyStructuredAgentAvailability {
  private handlePromise: Promise<AvailabilityHandle> | null = null

  constructor(
    private readonly getStore: () => Pick<RuntimeStore, 'onSettingsChanged'> | null,
    private readonly runtime: AvailabilityRuntime
  ) {}

  subscribe(read: StructuredAgentAvailabilityReader): () => void {
    let active = true
    let release: (() => void) | null = null
    this.handlePromise ??= import('./structured-agent-availability')
      .then(({ installStructuredAgentAvailability: install }) =>
        install(this.getStore(), this.runtime)
      )
      .catch((error: unknown) => {
        this.handlePromise = null
        throw error
      })
    void this.handlePromise
      .then((handle) => {
        if (active) {
          release = handle.subscribe(read)
        }
      })
      .catch((error: unknown) => {
        console.warn('[runtime] failed to load structured agent availability', error)
      })
    return () => {
      active = false
      release?.()
      release = null
    }
  }
}
