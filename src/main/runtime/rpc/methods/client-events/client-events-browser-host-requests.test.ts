import { expect, it } from 'vitest'
import {
  BROWSER_CLIENT_HOST_REQUEST_CAPABILITY,
  type BrowserClientHostRequestEvent
} from '../../../../../shared/browser/client-hosting/browser-client-host-request-protocol'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { getBrowserHostRequestRegistry } from '../../../browser-host/leases/browser-host-request-registry'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../../core'
// Import the registry to avoid client-events' module-init cycle through ipc/ssh.
import { ALL_RPC_METHODS } from '../rpc-method-registry'

const subscribeMethod = eraseRpcMethods(ALL_RPC_METHODS)
  .filter(isStreamingMethod)
  .find((method) => method.name === 'runtime.clientEvents.subscribe')

function makeRuntime(): { runtime: OrcaRuntimeService; cleanups: (() => void)[] } {
  const cleanups: (() => void)[] = []
  const fake = {
    getRuntimeId: () => 'runtime-a',
    onClientEvent: () => () => {},
    getClientSettings: () => ({ nativeChatQueueFollowUps: true }),
    registerSubscriptionCleanup: (_id: string, cleanup: () => void) => {
      cleanups.push(cleanup)
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the subscribe handler reads only these members.
  return { runtime: fake as unknown as OrcaRuntimeService, cleanups }
}

it('asks only the opted-in subscription of a capable desktop socket to host browser pages', async () => {
  if (!subscribeMethod) {
    throw new Error('runtime.clientEvents.subscribe is not a streaming method')
  }
  const { runtime, cleanups } = makeRuntime()
  const desktop: RpcContext = {
    runtime,
    connectionId: 'conn-1',
    clientKind: 'runtime',
    pairedDeviceId: 'device-a',
    clientCapabilities: [BROWSER_CLIENT_HOST_REQUEST_CAPABILITY]
  }
  const relayed: unknown[] = []
  const rendered: unknown[] = []
  const web: unknown[] = []
  const done = [
    subscribeMethod.handler({}, desktop, (event) => relayed.push(event)),
    subscribeMethod.handler({ browserHostRequests: true }, desktop, (event) =>
      rendered.push(event)
    ),
    subscribeMethod.handler(
      { browserHostRequests: true },
      { ...desktop, connectionId: 'conn-2', pairedDeviceId: 'device-b', clientCapabilities: [] },
      (event) => web.push(event)
    )
  ]
  const requests = getBrowserHostRequestRegistry(runtime)

  const hosted = requests.request()
  const asked = rendered.find(isHostRequest)
  if (!asked) {
    throw new Error('the opted-in subscription was not asked to host')
  }
  requests.settle(
    { pairedDeviceId: 'device-a' },
    { requestId: asked.requestId, browserHostClientId: 'host-a' }
  )

  await expect(hosted).resolves.toEqual({
    browserHostClientId: 'host-a',
    pairedDeviceId: 'device-a'
  })
  expect(relayed.some(isHostRequest)).toBe(false)
  expect(web.some(isHostRequest)).toBe(false)
  cleanups.forEach((cleanup) => cleanup())
  expect(requests.hasVolunteer()).toBe(false)
  await Promise.all(done)
})

function isHostRequest(event: unknown): event is BrowserClientHostRequestEvent {
  return (
    typeof event === 'object' &&
    event !== null &&
    'type' in event &&
    event.type === 'browserHostRequested'
  )
}
