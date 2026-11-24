// Host removal needs the native host list and credential; pages have only init.host and must refuse.
// Keep the error outside the .web sibling so shared screen catches can import it.

/** The machine token. `message` is user-facing copy, so callers branch on this. */
export const PAGE_HOST_REMOVAL_UNAVAILABLE_CODE = 'page_host_removal_unavailable'

const PAGE_HOST_REMOVAL_UNAVAILABLE_NAME = 'PageHostRemovalUnavailableError'

export class PageHostRemovalUnavailableError extends Error {
  readonly code = PAGE_HOST_REMOVAL_UNAVAILABLE_CODE

  constructor() {
    // Name the native removal surface because retrying inside this page cannot succeed.
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
