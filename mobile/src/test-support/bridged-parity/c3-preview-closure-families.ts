import type { PageClosurePins } from './page-closure'

/**
 * The goldens the file preview adds to the C3 closure, and what each one did at the bridge.
 *
 * Five families, all recorded at `mobile-file-preview-request.ts` and its grant refresh: the two
 * text reads (`files.read` for a worktree file, `files.readTerminalArtifact` for an artifact), the
 * two image reads that answer base64 the screen composes into a `data:` URI, and the artifact save.
 * Every non-matrix golden here replays byte-identically, so the preview's own reads and its one
 * write are certified as bytes rather than as a named divergence.
 *
 * What these do not exercise: no golden replays a save twice, so `files.writeTerminalArtifact` is
 * not certified idempotent or retry-safe, and the grant refresh is driven only through
 * `files-preview-grant-refresh`'s single stale-grant path.
 */
export const C3_PREVIEW_CLOSURE_FAMILIES: PageClosurePins = {
  'files.preview-artifact-image': {
    'files-preview-artifact-image-read': 'identical',
    'matrix-files.preview-artifact-image-files.readterminalartifactpreview-1':
      'result-absent-settlement'
  },
  'files.preview-load': {
    'files-preview-artifact-direct': 'identical',
    'files-preview-artifact-image': 'identical',
    'files-preview-grant-refresh': 'identical',
    'files-preview-worktree': 'identical',
    'files-preview-worktree-image': 'identical',
    'matrix-files.preview-load-files.readterminalartifact-1': 'result-absent-settlement',
    'matrix-files.preview-load-files.readterminalartifact-2': 'result-absent-settlement',
    'matrix-files.preview-load-files.resolveterminalpath-1': 'result-absent-settlement'
  },
  'files.preview-save': {
    'files-save-blind': 'identical',
    'files-save-verified': 'identical',
    'matrix-files.preview-save-files.readterminalartifact-1': 'result-absent-settlement',
    'matrix-files.preview-save-files.writeterminalartifact-1': 'result-absent-settlement'
  },
  'files.preview-worktree-image': {
    'files-preview-worktree-image-read': 'identical',
    'matrix-files.preview-worktree-image-files.readpreview-1': 'result-absent-settlement'
  },
  'files.preview-worktree-text': {
    'files-preview-worktree-text-read': 'identical',
    'matrix-files.preview-worktree-text-files.read-1': 'result-absent-settlement'
  }
}
