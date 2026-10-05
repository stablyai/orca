import type { UnvalidatedRpcRequestPort } from '../../transport/rpc/unvalidated-rpc-request-port'

export type HostPushState = {
  connection: {
    client: UnvalidatedRpcRequestPort | null
    support: ReturnType<typeof createHostPushSupportCompletion> | null
  }
  // An unanswered probe is unknown, not unsupported.
  supported: boolean | null
  sealable: boolean
  capabilityProbeStop: (() => void) | null
  chain: Promise<void>
}

export type HostPushSupportCompletion = {
  readonly completed: Promise<boolean | null>
  readonly signal: AbortSignal
}

export function createHostPushSupportCompletion() {
  let complete: (supported: boolean | null) => void = () => {}
  const completed = new Promise<boolean | null>((resolve) => {
    complete = resolve
  })
  const controller = new AbortController()
  return {
    completed,
    signal: controller.signal,
    complete,
    retire() {
      complete(null)
      controller.abort()
    }
  }
}

export function createHostPushState(): HostPushState {
  return {
    connection: { client: null, support: null },
    supported: null,
    sealable: false,
    capabilityProbeStop: null,
    chain: Promise.resolve()
  }
}
