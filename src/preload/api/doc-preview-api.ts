import type { DocPreviewExternalLink, DocPreviewFailure } from '../../shared/doc-preview-scheme'

export type DocPreviewGrantOwner =
  | { kind: 'ssh'; connectionId: string }
  | {
      kind: 'runtime'
      environmentId: string
      worktreeSelector: string
      worktreeRoot: string
    }

export type DocPreviewGrantRequest = {
  owner: DocPreviewGrantOwner
  /** Directory that relative preview URLs resolve against. */
  requestBase: string
  /** Initial filesystem authority; always the opened document's directory. */
  root: string
  entryRelativePath: string
  browserPageId: string
}

export type DocPreviewApi = {
  docPreview: {
    mintGrant: (request: DocPreviewGrantRequest) => Promise<{ grantId: string; url: string }>
    revokeGrant: (grantId: string) => Promise<boolean>
    authorizeDirectory: (grantId: string, relativePath: string) => Promise<boolean>
    onExternalLink: (callback: (payload: DocPreviewExternalLink) => void) => () => void
    onLoadFailure: (callback: (payload: DocPreviewFailure) => void) => () => void
  }
}
