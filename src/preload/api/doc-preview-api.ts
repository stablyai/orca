import type { DocPreviewFailure } from '../../shared/doc-preview-scheme'

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
  root: string
  entryRelativePath: string
  /** Browser page the document is being opened in; main registers its guest under this id. */
  browserPageId: string
}

export type DocPreviewApi = {
  docPreview: {
    mintGrant: (request: DocPreviewGrantRequest) => Promise<{ grantId: string; url: string }>
    revokeGrant: (grantId: string) => Promise<boolean>
    /** External link the preview guest tried to open; the renderer turns it into a browser tab. */
    onExternalLink: (callback: (payload: { url: string }) => void) => () => void
    /** Why the guest is showing an error body instead of the document. */
    onLoadFailure: (callback: (payload: DocPreviewFailure) => void) => () => void
  }
}
