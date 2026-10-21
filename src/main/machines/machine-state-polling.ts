import type { MachineRecord, MachineState } from '../../shared/machine-inventory'

const POLL_INTERVAL_MS = 3_000

/** Re-reads a machine every 3 s while it is in a transitional state, until the deadline. */
export async function pollWhileMachineState(
  record: MachineRecord,
  transitional: MachineState,
  options: {
    read: () => Promise<MachineRecord>
    delay: (ms: number) => Promise<void>
    now: () => number
    deadline: number
  }
): Promise<MachineRecord> {
  let current = record
  while (current.state === transitional && options.now() < options.deadline) {
    await options.delay(POLL_INTERVAL_MS)
    current = await options.read()
  }
  return current
}
