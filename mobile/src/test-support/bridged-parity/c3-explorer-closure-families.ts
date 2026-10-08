import type { PageClosurePins } from './page-closure'

/**
 * The goldens the file explorer adds to the C3 closure, and what each one did at the bridge.
 *
 * One family: `MobileFileExplorerPanel.tsx` is the only site in this route's closure the corpus
 * records against. Its two directory reads are the pair the screen chooses between —
 * `files.readDir` where the desktop allowlists it, and the capped `files.list` fallback where it
 * does not — and both replay byte-identically. The two `matrix-` goldens are the reply partitions
 * driven at those same sites, which land in `result-absent-settlement` for the reason the suite's
 * own docstring gives:
 * the recorder injects `{ ok: true }` with no `result` below the frame boundary, and a shape the
 * wire itself drops has no byte-identical replay available at any bridge.
 *
 * Split from the preview's table at the route seam rather than kept in one file: the two are
 * separate entries in `MOBILE_WEB_PAGE_ROUTES` with their own grants, and this is the evidence for
 * one of them.
 */
export const C3_EXPLORER_CLOSURE_FAMILIES: PageClosurePins = {
  'files.explorer-screen': {
    'files-explorer-legacy-fallback': 'identical',
    'files-explorer-readdir': 'identical',
    'matrix-files.explorer-screen-files.list-1': 'result-absent-settlement',
    'matrix-files.explorer-screen-files.readdir-1': 'result-absent-settlement'
  }
}
