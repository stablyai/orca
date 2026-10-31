import { createBridgePortPair } from './bridge-port-pair-test-harness'
import { createFakeRpcClient, type FakeRpcClient } from '../bridge-host-test-fakes'
import type { RpcClient } from '../../transport/rpc-client'
import type { BridgePortPair, BridgePortPairOptions } from './bridge-port-pair-contract'

export function createFakeBridgePortPair(
  options: Omit<BridgePortPairOptions<FakeRpcClient>, 'rpc'> & { rpc?: FakeRpcClient } = {}
): BridgePortPair<FakeRpcClient> {
  return createBridgePortPair({ ...options, rpc: options.rpc ?? createFakeRpcClient() })
}

// Attempt each already-owned teardown phase even when an earlier original close throws.
export async function disposeBridgePortPair(
  pair: Pick<BridgePortPair<RpcClient>, 'client' | 'host' | 'flush'>
): Promise<void> {
  const errors: unknown[] = []
  for (const cleanup of [
    () => pair.client.close(),
    () => pair.host.dispose(),
    () => pair.flush()
  ]) {
    try {
      await cleanup()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) {
    throw errors[0]
  }
  if (errors.length) {
    throw new AggregateError(errors, 'Bridge pair teardown failed')
  }
}
