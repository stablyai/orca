import type { PageClosurePins } from './page-closure'

// Preview read/save recordings cover one round trip and one stale-grant path; they do not establish save retry safety.
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
