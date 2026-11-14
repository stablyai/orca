import { AsyncLocalStorage } from 'node:async_hooks'

type UserActScope = { distro: string; active: boolean }

// The distro a user act may start; reads and Git it triggers (e.g. a roots rebuild) pass for it alone.
const userActScope = new AsyncLocalStorage<UserActScope>()

function distroKey(distro: string): string {
  return distro.trim().toLowerCase()
}

/**
 * Runs a user act on `distro`: gated work inside it may start that distro, and no other. The
 * allowance ends with the act, so timers, listeners or queues created inside it (which keep its
 * async context) never start the distro later, e.g. after the user terminates it. `onSettled`
 * runs while the allowance still holds, whether the act succeeded or threw.
 */
export async function runAsWslUserAct<T>(
  distro: string | null,
  act: () => Promise<T>,
  options: { onSettled?: (distro: string) => void } = {}
): Promise<T> {
  if (!distro) {
    return act()
  }
  const scope: UserActScope = { distro: distroKey(distro), active: true }
  try {
    return await userActScope.run(scope, async () => {
      try {
        return await act()
      } finally {
        options.onSettled?.(distro)
      }
    })
  } finally {
    scope.active = false
  }
}

export function isWslUserActFor(distro: string): boolean {
  const scope = userActScope.getStore()
  return scope?.active === true && scope.distro === distroKey(distro)
}

/** Runs `work` outside any user act, so deferred or listener work never inherits one. */
export function outsideWslUserAct<T>(work: () => T): T {
  return userActScope.exit(work)
}
