import { handleRuntimeEnvironmentChannel } from '../runtime-environment-channel-handling'
import { registerRuntimeEnvironmentSubscriptionControls } from './runtime-environment-binary-payload'
import type {
  RuntimeEnvironmentSubscribeArgs,
  RuntimeEnvironmentSubscriptionHandlerDependencies
} from './runtime-environment-subscription-setup'
import { subscribeRuntimeEnvironmentForDocument } from './runtime-environment-document-subscription'
import { electronDocumentEndpoint } from '../../../backend-desktop/electron-document-endpoint'

export function registerRuntimeEnvironmentSubscriptionHandlers(
  args: RuntimeEnvironmentSubscriptionHandlerDependencies
): void {
  handleRuntimeEnvironmentChannel(
    'runtimeEnvironments:subscribe',
    (event, subscribe: RuntimeEnvironmentSubscribeArgs) =>
      subscribeRuntimeEnvironmentForDocument(args, electronDocumentEndpoint(event), subscribe)
  )
  registerRuntimeEnvironmentSubscriptionControls(
    args.pendingSubscriptions,
    args.remoteRuntimeSubscriptions
  )
}
