import { BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY } from '../../../../shared/browser/runtime/browser-runtime-capabilities'
import { BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY } from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../../rpc/dispatcher'
import { BROWSER_CLIENT_HOST_METHODS } from '../../rpc/methods/browser/browser-client-host'
import { BROWSER_CLIENT_PAGE_INITIALIZATION_CAPABILITY } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import { BrowserClientHostCommandDispatcher } from '../../../browser/client-hosts/commands/browser-client-host-command-dispatcher'
import { createRecoveryNativeLoop } from './client-page-recovery-native-test-harness'

export function createRecoveryPeer(
  runtime: OrcaRuntimeService,
  hostId: string,
  deviceId = 'device-a'
) {
  const native = createRecoveryNativeLoop({})
  const executor = native.createExecutor()
  const stopped = new AbortController()
  const rpc = new RpcDispatcher({ runtime, methods: BROWSER_CLIENT_HOST_METHODS })
  const caller = {
    connectionId: `connection-${hostId}`,
    pairedDeviceId: deviceId,
    clientKind: 'runtime' as const,
    clientCapabilities: [BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY]
  }
  let dispatcher: BrowserClientHostCommandDispatcher | undefined
  let completion: Promise<void> | undefined
  const errors: unknown[] = []
  const commands: string[] = []
  return {
    ...native,
    executor,
    errors,
    commands,
    attach() {
      completion = rpc.dispatchStreaming(
        {
          id: hostId,
          authToken: 'test',
          method: 'browser.clientHost.attach',
          params: {
            authorityRuntimeId: runtime.getRuntimeId(),
            browserHostClientId: hostId,
            hostCapabilities: [
              'webview',
              BROWSER_CLIENT_AUTOMATION_HOST_CAPABILITY,
              BROWSER_CLIENT_PAGE_INITIALIZATION_CAPABILITY
            ],
            pageCommandProtocolVersion: 1,
            pageInventoryProtocolVersion: 1,
            pageReconciliationProtocolVersion: 1,
            leaseReconnectProtocolVersion: 1,
            pageInventory: executor.snapshotPageInventory()
          }
        },
        (reply) => {
          const message = JSON.parse(reply)
          if (message.ok === false) {
            errors.push(message.error)
            return
          }
          const event = message.result
          if (event?.type === 'ready') {
            dispatcher = new BrowserClientHostCommandDispatcher({
              authority: {
                ...event,
                authorityRuntimeId: runtime.getRuntimeId(),
                browserHostClientId: hostId
              },
              handler: (command, signal, close) => executor.handle(command, signal, close),
              acquireInitialization: (command) => executor.acquireInitialization(command)
            })
          } else if (event?.type === 'command') {
            commands.push(event.browserPageId)
            void dispatcher!
              .dispatch(event)
              .then((result) =>
                rpc.dispatchStreaming(
                  {
                    id: event.commandId,
                    authToken: 'test',
                    method: 'browser.clientHost.commandResult',
                    params: { ...event, result }
                  },
                  () => {},
                  caller
                )
              )
              .catch((error) => errors.push(error))
          }
        },
        { ...caller, signal: stopped.signal }
      )
    },
    async close() {
      stopped.abort()
      native.releaseAll()
      await dispatcher?.close()
      await executor.close()
      await completion
    }
  }
}
