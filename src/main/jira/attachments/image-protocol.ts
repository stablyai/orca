import { protocol } from 'electron'
import { JIRA_IMAGE_SCHEME, jiraImageReference } from '../../../shared/jira-attachment-image'
import { readGrantedAttachmentImage } from './image-read'

export const JIRA_IMAGE_CUSTOM_SCHEME: Electron.CustomScheme = {
  scheme: JIRA_IMAGE_SCHEME,
  privileges: { standard: true, secure: true, stream: true }
}

export async function handleJiraImageRequest(request: Request): Promise<Response> {
  const reference = jiraImageReference(request.url)
  if (!reference) {
    return new Response(null, { status: 404 })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405 })
  }
  try {
    const image = await readGrantedAttachmentImage(reference, request.signal)
    if (!image) {
      return new Response(null, { status: 404 })
    }
    return new Response(request.method === 'HEAD' ? null : image.data, {
      headers: {
        'Content-Type': image.mimeType,
        'Content-Length': String(image.data.byteLength),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      }
    })
  } catch {
    return new Response(null, { status: 404 })
  }
}

export function installJiraImageProtocolHandler(): void {
  protocol.handle(JIRA_IMAGE_SCHEME, handleJiraImageRequest)
}
