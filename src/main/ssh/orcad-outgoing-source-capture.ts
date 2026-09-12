import { bindOutgoingOrcadSource } from './orcad-outgoing-source-binding'
import { PTY_OWNERSHIP_CAPTURE_METHODS } from '../../shared/pty-ownership-capture-wire'
import { captureOutgoingOrcadModel } from './orcad-outgoing-capture'

type CaptureOptions = Parameters<typeof captureOutgoingOrcadModel>[0]

/** Caller holds source lifecycle authority and supplies an already-prepared delegated source. */
export async function captureOutgoingOrcadSource(options: {
  store: CaptureOptions['store']
  destination: CaptureOptions['destination']
  identity: CaptureOptions['capture']['identity']
  ptyId: string
  runtime: CaptureOptions['capture']['runtime']
  signal: AbortSignal
  assertAuthority: () => void
}) {
  const destination = structuredClone(options.destination)
  const { identity, ptyId, provider, providerGeneration, request, assertSource } =
    bindOutgoingOrcadSource({
      ...options,
      sourceSshTargetId: destination.sourceSshTargetId
    })
  if (options.store.read(identity)) {
    throw new Error('orcad_outgoing_capture_recovery_required')
  }
  const capabilities = await provider.getOwnershipBridgeCapabilities?.({ signal: options.signal })
  assertSource()
  const result = await captureOutgoingOrcadModel({
    store: options.store,
    destination,
    capture: {
      identity,
      route: { ptyId, providerGeneration: providerGeneration! },
      runtime: options.runtime,
      signal: options.signal,
      capabilities: capabilities ?? {},
      request: async (method, params) => {
        // Cleanup stays on the original provider even when cancellation/reconnect invalidates admission.
        if (method === PTY_OWNERSHIP_CAPTURE_METHODS.release) {
          return request(method, params, { timeoutMs: 5_000 })
        }
        assertSource()
        const reply = await request(method, params, { signal: options.signal, timeoutMs: 5_000 })
        // Let begin hand its token to the capture owner so stale authority still triggers release.
        if (method !== PTY_OWNERSHIP_CAPTURE_METHODS.begin) {
          assertSource()
        }
        return reply
      }
    }
  })
  assertSource()
  return result
}
