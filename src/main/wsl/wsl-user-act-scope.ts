import { AsyncLocalStorage } from 'node:async_hooks'

// The distro a user act may start; reads and Git it triggers (e.g. a roots rebuild) pass for it alone.
const userActDistro = new AsyncLocalStorage<string>()

function distroKey(distro: string): string {
  return distro.trim().toLowerCase()
}

/** Runs a user act on `distro`: gated work inside it may start that distro, and no other. */
export function runAsWslUserAct<T>(distro: string | null, act: () => Promise<T>): Promise<T> {
  return distro ? userActDistro.run(distroKey(distro), act) : act()
}

export function isWslUserActFor(distro: string): boolean {
  return userActDistro.getStore() === distroKey(distro)
}

/** Runs `work` outside any user act, so deferred or listener work never inherits one. */
export function outsideWslUserAct<T>(work: () => T): T {
  return userActDistro.exit(work)
}
