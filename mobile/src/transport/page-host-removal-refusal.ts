/**
 * Removing a host is pairing work, and the page cannot do it.
 *
 * `host-store.web.ts` says what this document holds: one profile from `init.host`, no host list and
 * no credential. There is nothing here to remove and no keychain entry to drop, so the page refuses
 * rather than reporting success for nothing. Declared apart from the `.web` sibling that throws it
 * because the catch that reads it is the app's screen, shared by both platforms.
 */

/** The machine token. `message` is user-facing copy, so callers branch on this. */
export const PAGE_HOST_REMOVAL_UNAVAILABLE_CODE = 'page_host_removal_unavailable'

const PAGE_HOST_REMOVAL_UNAVAILABLE_NAME = 'PageHostRemovalUnavailableError'

export class PageHostRemovalUnavailableError extends Error {
  readonly code = PAGE_HOST_REMOVAL_UNAVAILABLE_CODE

  constructor() {
    // Why plain copy: this reaches the host screen's error banner unchanged, and it has to name
    // where removal does work rather than ask for a retry that cannot succeed here.
    super('Remove this host from the host list in the Orca app.')
    this.name = PAGE_HOST_REMOVAL_UNAVAILABLE_NAME
  }
}

/** The code and not `instanceof`, so a second copy of this module still reads as the refusal. */
export function isPageHostRemovalUnavailable(
  error: unknown
): error is PageHostRemovalUnavailableError {
  return (
    error instanceof Error && 'code' in error && error.code === PAGE_HOST_REMOVAL_UNAVAILABLE_CODE
  )
}
