const mutationQuarantines = new WeakSet<object>()

export const COOKIE_MUTATION_QUARANTINED_REASON =
  'A cookie import timed out in Chromium, so this browser session is locked for safety. Restart Orca before importing cookies again.'

export class CookieMutationQuarantinedError extends Error {
  constructor() {
    super(COOKIE_MUTATION_QUARANTINED_REASON)
    this.name = 'CookieMutationQuarantinedError'
  }
}

export function quarantineCookieMutations(owner: object): void {
  mutationQuarantines.add(owner)
}

export function assertCookieMutationsAvailable(owner: object): void {
  if (mutationQuarantines.has(owner)) {
    throw new CookieMutationQuarantinedError()
  }
}

export function areCookieMutationsQuarantined(owner: object): boolean {
  return mutationQuarantines.has(owner)
}

export function isCookieMutationQuarantinedError(
  error: unknown
): error is CookieMutationQuarantinedError {
  return error instanceof CookieMutationQuarantinedError
}
