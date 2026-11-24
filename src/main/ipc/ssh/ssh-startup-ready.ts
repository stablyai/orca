let readiness: Promise<unknown> = Promise.resolve()

export function setSshStartupReady(ready: Promise<unknown>): void {
  readiness = ready
}

export function awaitSshStartupReady(): Promise<unknown> {
  return readiness
}
