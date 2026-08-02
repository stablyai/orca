import { runKeyedSerializedOperation } from './keyed-promise-queue'

const operationQueues = new Map<string, Promise<void>>()

/**
 * Canonical key for a WSL distro name. The operation queue and the
 * registration registry must agree on this to serialize against each other.
 */
export function normalizeWslDistroKey(distro: string): string {
  return distro.trim().toLowerCase()
}

/**
 * Serializes registration reads and mutations for one WSL distro.
 */
export function runSerializedWslCliRegistrationOperation<T>(
  distro: string,
  operation: () => Promise<T>
): Promise<T> {
  // Why: startup repair continues in the background and can otherwise undo a
  // concurrent Settings install/remove or overwrite its ownership metadata.
  return runKeyedSerializedOperation(operationQueues, normalizeWslDistroKey(distro), operation)
}
