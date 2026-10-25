import { runKeyedSerializedOperation } from './keyed-promise-queue'

const operationQueues = new Map<string, Promise<void>>()

/** The operation queue and registration registry must use the same distro key. */
export function normalizeWslDistroKey(distro: string): string {
  return distro.trim().toLowerCase()
}

export function runSerializedWslCliRegistrationOperation<T>(
  distro: string,
  operation: () => Promise<T>
): Promise<T> {
  // Background repair must not undo concurrent Settings changes or overwrite their ownership.
  return runKeyedSerializedOperation(operationQueues, normalizeWslDistroKey(distro), operation)
}
