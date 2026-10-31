import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrcaRuntimeRpcServer } from '../runtime-rpc'

export type DesktopPushRuntime = Pick<
  OrcaRuntimeService,
  'setMobilePushOrigin' | 'setMobilePushRegistrar' | 'onNotificationDispatched'
>
export type DesktopPushRuntimeRpc = Pick<
  OrcaRuntimeRpcServer,
  'getE2EEKeypair' | 'getDeviceRegistry' | 'getPushUnregisterOutbox' | 'setOnPushUnregisterQueued'
>
