import { isDaemonEndpointGoneError } from '../../protocol/daemon-errors'

/**
 * Reconnect attempts after a preserved daemon's connection drops. Every attempt must find the
 * endpoint refused or missing: a timeout or other error cannot tell a busy host from a dead one.
 */
export const PRESERVED_ENDPOINT_LOSS_PROBE_DELAYS_MS: readonly number[] = [500, 2_000, 5_000]

export type PreservedEndpointLossVerdict = 'gone' | 'reachable' | 'unproven' | 'abandoned'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Decide whether a daemon Orca cannot respawn is gone for good, so its PTYs can end as host loss. */
export async function confirmPreservedEndpointLoss(args: {
  connect: () => Promise<void>
  shouldContinue: () => boolean
  delaysMs?: readonly number[]
  sleep?: (ms: number) => Promise<void>
}): Promise<PreservedEndpointLossVerdict> {
  const sleep = args.sleep ?? delay
  for (const ms of args.delaysMs ?? PRESERVED_ENDPOINT_LOSS_PROBE_DELAYS_MS) {
    await sleep(ms)
    if (!args.shouldContinue()) {
      return 'abandoned'
    }
    try {
      await args.connect()
      return 'reachable'
    } catch (error) {
      if (!isDaemonEndpointGoneError(error)) {
        return 'unproven'
      }
    }
  }
  return 'gone'
}
