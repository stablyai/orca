import type { PageClosurePins } from './page-closure'

// Keep explorer evidence separate from preview route grants; injected absent-result partitions have no valid wire equivalent.
export const C3_EXPLORER_CLOSURE_FAMILIES: PageClosurePins = {
  'files.explorer-screen': {
    'files-explorer-legacy-fallback': 'identical',
    'files-explorer-readdir': 'identical',
    'matrix-files.explorer-screen-files.list-1': 'result-absent-settlement',
    'matrix-files.explorer-screen-files.readdir-1': 'result-absent-settlement'
  }
}
