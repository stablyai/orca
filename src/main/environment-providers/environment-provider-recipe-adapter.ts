// Drivers answer in the shape a shell recipe prints, so runtime records, write-ahead, pairing reuse
// on resume and host health keep one code path for every provider.
import { z } from 'zod'
import {
  getEphemeralVmRecipeResultConnection,
  type EphemeralVmRecipeResult,
  type JsonValue
} from '../../shared/ephemeral-vm-recipes'
import type { EphemeralVmCheckoutMode } from '../../shared/orca-yaml-hook-types'
import type { EnvironmentHandle, EnvironmentReady } from './environment-provider-driver'

const USER_DATA_KEY = 'environmentDriver'

const HandleSchema = z
  .object({
    driverId: z.string().min(1).max(64),
    environmentId: z.string().min(1).max(128),
    driverState: z.record(z.string(), z.json())
  })
  .strict()

export function environmentReadyToRecipeResult(
  ready: EnvironmentReady,
  checkoutMode: EphemeralVmCheckoutMode
): EphemeralVmRecipeResult {
  const userData: Record<string, JsonValue> = {
    [USER_DATA_KEY]: {
      driverId: ready.handle.driverId,
      environmentId: ready.handle.environmentId,
      driverState: ready.handle.driverState
    }
  }
  const connection = getEphemeralVmRecipeResultConnection(ready.result)
  return checkoutMode === 'provisioned-root'
    ? { schemaVersion: 2, checkoutMode: 'provisioned-root', connection, userData }
    : { schemaVersion: 1, connection, userData }
}

/** Null when the record came from a shell recipe or was written by another driver. */
export function environmentHandleFromRecipeResult(
  result: EphemeralVmRecipeResult,
  driverId: string
): EnvironmentHandle | null {
  if (getEphemeralVmRecipeResultConnection(result).type !== 'orca-server') {
    return null
  }
  const parsed = HandleSchema.safeParse(result.userData?.[USER_DATA_KEY])
  if (!parsed.success || parsed.data.driverId !== driverId) {
    return null
  }
  // SAFETY: z.json() validated every value as JSON; its inferred type is structurally JsonValue.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see above.
  return parsed.data as EnvironmentHandle
}
