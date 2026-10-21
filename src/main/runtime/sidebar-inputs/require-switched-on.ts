/** A producer that exists only with ORCA_SIDEBAR_INPUTS=main, read where that build is certain. */
export function requireSwitchedOn<Producer>(producer: Producer | null): Producer {
  if (producer === null) {
    throw new Error('sidebar inputs are off in this build')
  }
  return producer
}
