import { Platform } from 'react-native'
import {
  ORCA_CLOUD_ENROLLMENT_SIGNED_OUT,
  ORCA_CLOUD_ENROLLMENT_UNAVAILABLE,
  OrcaCloudEnrollDeviceResultSchema
} from '../../../src/shared/orca-cloud-device-enrollment-contract'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../transport/rpc/rpc-operation-result-reader'
import type { UnvalidatedRpcRequestPort } from '../transport/rpc/unvalidated-rpc-request-port'
import { loadCloudDeviceIdentity, saveCloudEnrollment } from './cloud-device-identity'

const enrollDevice = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'orca-cloud.enroll-device',
    method: 'orcaCloud.enrollDevice',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('orca-cloud-device-session', OrcaCloudEnrollDeviceResultSchema)
  })
)

export type CloudEnrollmentFailure = 'signed-out' | 'not-offered' | 'unreachable'

export class CloudEnrollmentError extends Error {
  constructor(readonly failure: CloudEnrollmentFailure) {
    super(failure)
    this.name = 'CloudEnrollmentError'
  }
}

function failureFor(message: string): CloudEnrollmentFailure {
  if (message.includes(ORCA_CLOUD_ENROLLMENT_SIGNED_OUT)) {
    return 'signed-out'
  }
  // Older desktops refuse the method by name; both mean "this desktop cannot lend Orca Cloud".
  if (
    message.includes(ORCA_CLOUD_ENROLLMENT_UNAVAILABLE) ||
    /not available|unknown method|method_not_found/i.test(message)
  ) {
    return 'not-offered'
  }
  return 'unreachable'
}

/** Borrows a paired desktop's Orca Cloud sign-in once to enroll this phone's own key. */
export async function enrollCloudDevice(args: {
  desktop: UnvalidatedRpcRequestPort
  desktopName: string
  deviceLabel: string
}): Promise<void> {
  const identity = await loadCloudDeviceIdentity()
  const platform = Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web'
  let result
  try {
    result = enrollDevice.interpret(
      await enrollDevice.request(
        args.desktop,
        { label: args.deviceLabel, platform, publicKeyB64: identity.publicKeyB64 },
        { timeoutMs: 20_000 }
      )
    )
  } catch (error) {
    throw new CloudEnrollmentError(
      failureFor(error instanceof Error ? error.message : String(error))
    )
  }
  await saveCloudEnrollment({
    controlPlaneUrl: result.controlPlaneUrl,
    deviceSessionId: result.deviceSession.id,
    label: result.deviceSession.label,
    enrolledAt: result.deviceSession.createdAt,
    viaHostName: args.desktopName
  })
}
