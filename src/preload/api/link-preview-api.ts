import type { LinkPreviewRequest, LinkPreviewResult } from '../../shared/link-preview'

export type LinkPreviewApi = {
  get: (request: LinkPreviewRequest) => Promise<LinkPreviewResult>
}
