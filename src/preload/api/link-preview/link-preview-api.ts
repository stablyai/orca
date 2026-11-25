import type { LinkPreviewRequest, LinkPreviewResult } from '../../../shared/browser/link-preview'

export type LinkPreviewApi = {
  get: (request: LinkPreviewRequest) => Promise<LinkPreviewResult>
}
