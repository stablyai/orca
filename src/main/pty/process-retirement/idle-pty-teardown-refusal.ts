export type PosixIdlePtyGuard = {
  shellPids: ReadonlySet<number>
  verifyIdle: () => void
}

export class IdlePtyTeardownRefusal extends Error {
  constructor(readonly reason: 'running_work' | 'unverifiable') {
    super(
      reason === 'running_work' ? 'Terminal work is running' : 'Terminal idle state is unverifiable'
    )
  }
}
