import { extractLinearInlineMedia } from '../../shared/linear/inline-media'
import { getPublicFileUrlClient, isAuthError, type LinearClientForWorkspace } from './client'

const DESCRIPTION_QUERY = `query OrcaLinearDescriptionImages($id: String!) {
  issue(id: $id) { description }
}`

export async function getDescriptionImageUrls(
  entry: LinearClientForWorkspace,
  issueId: string,
  description: string | undefined
): Promise<Record<string, string> | undefined> {
  const uploads = extractLinearInlineMedia(description, 'description').filter(
    (media) => media.linearUpload
  )
  if (uploads.length === 0) {
    return undefined
  }

  try {
    const result = await getPublicFileUrlClient(entry).client.rawRequest<
      { issue?: { description?: string | null } | null },
      Record<string, unknown>
    >(DESCRIPTION_QUERY, { id: issueId })
    const signed = extractLinearInlineMedia(result.data?.issue?.description, 'description').filter(
      (media) => media.linearUpload
    )
    const signedByPath = new Map(signed.map((media) => [new URL(media.url).pathname, media.url]))
    // Keep access signatures out of the editable Markdown and its save payload.
    return Object.fromEntries(
      uploads.flatMap((media) => {
        const url = signedByPath.get(new URL(media.url).pathname)
        return url ? [[media.url, url]] : []
      })
    )
  } catch (error) {
    if (isAuthError(error)) {
      throw error
    }
    console.warn('[linear] description image URLs failed:', error)
    return undefined
  }
}
