import {
  ORCA_CLOUD_ENROLL_DEVICE_METHOD,
  ORCA_CLOUD_ENROLLMENT_UNAVAILABLE,
  OrcaCloudEnrollDeviceParamsSchema,
  type OrcaCloudEnrollDeviceParams,
  type OrcaCloudEnrollDeviceResult
} from '../../../../../shared/orca-cloud-device-enrollment-contract'
import { defineMethod } from '../../core'

export type OrcaCloudDeviceEnroller = {
  enroll: (
    params: OrcaCloudEnrollDeviceParams & { pairedDeviceId?: string }
  ) => Promise<OrcaCloudEnrollDeviceResult>
  /** The phone was unpaired on this desktop: its cloud access ends with it. */
  revokeForPairedDevice: (pairedDeviceId: string) => Promise<void>
}

let enroller: OrcaCloudDeviceEnroller | null = null

/** Desktop main registers this when Orca Cloud is configured; headless servers never do. */
export function registerOrcaCloudDeviceEnroller(next: OrcaCloudDeviceEnroller | null): void {
  enroller = next
}

/** Best effort: a desktop without Orca Cloud, or offline, leaves the 14-day re-vouch cap to end it. */
export function revokeOrcaCloudAccessForUnpairedPhone(pairedDeviceId: string): void {
  void enroller?.revokeForPairedDevice(pairedDeviceId).catch(() => undefined)
}

export const ORCA_CLOUD_DEVICE_ENROLLMENT_METHODS = [
  defineMethod({
    name: ORCA_CLOUD_ENROLL_DEVICE_METHOD,
    // A paired phone already acts as this desktop's user; this lends it the same user's Cloud access.
    permission: 'workspace',
    params: OrcaCloudEnrollDeviceParamsSchema,
    handler: async (params, ctx) => {
      // Only a phone paired directly to this desktop: never a paired runtime client or the CLI.
      if (!enroller || ctx.clientKind !== 'mobile' || !ctx.pairedDeviceId) {
        throw new Error(ORCA_CLOUD_ENROLLMENT_UNAVAILABLE)
      }
      return await enroller.enroll({ ...params, pairedDeviceId: ctx.pairedDeviceId })
    }
  })
]
