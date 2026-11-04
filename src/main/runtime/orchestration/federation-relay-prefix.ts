import type { RuntimeRequestPreparation } from '../../../shared/runtime-rpc-envelope'
import { REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES } from '../../../shared/remote-runtime/remote-runtime-memory-limits'
import { OrchestrationError } from './orchestration-error'
import type { federationRelayWireItem } from './federation-relay-wire'

/** Fit only this already-selected page, using the actual sending socket's complete serializer. */
export function federationRelayPrefix(
  dispatchId: string,
  items: readonly ReturnType<typeof federationRelayWireItem>[],
  selected: (lastSequence: number) => void
): RuntimeRequestPreparation {
  return ({ envelope, measure }) => {
    const candidate = (count: number) => ({
      params: { dispatchId, items: items.slice(0, count) },
      envelope: {
        ...envelope,
        orchestrationRequestId: `relay_import_${dispatchId}_${items[count - 1]?.sequence ?? 0}`
      }
    })
    let low = 1
    let high = items.length
    let fit = 0
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const request = candidate(middle)
      if (
        measure(request.params, request.envelope) <= REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES
      ) {
        fit = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    if (!fit) {
      throw new OrchestrationError(
        'invalid_argument',
        'The federation request cannot fit the connected server request limit.'
      )
    }
    selected(items[fit - 1]!.sequence)
    return candidate(fit)
  }
}
