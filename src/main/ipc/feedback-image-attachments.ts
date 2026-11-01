import { readFetchResponseJsonWithinLimit } from '../../shared/fetch-response-body'
import {
  MAX_FEEDBACK_IMAGE_BYTES,
  MAX_FEEDBACK_IMAGE_COUNT,
  MAX_FEEDBACK_IMAGE_TOTAL_BYTES
} from '../../shared/feedback-image-limits'
import type { FeedbackImageAttachment } from '../../shared/feedback-submit-contract'

// Match the server allow-list; Slack selects rendering by filename extension.
const FEEDBACK_IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

export const MAX_FEEDBACK_IMAGE_RESPONSE_BYTES = 64 * 1024
export const FEEDBACK_IMAGE_FORM_FIELD = 'feedbackImage'

export function isSupportedFeedbackImageContentType(contentType: string): boolean {
  // Own-property checks exclude prototype members such as constructor and __proto__.
  return Object.hasOwn(FEEDBACK_IMAGE_EXTENSIONS, contentType)
}

export function feedbackImageFilename(index: number, contentType: string): string {
  return `feedback-image-${index + 1}.${FEEDBACK_IMAGE_EXTENSIONS[contentType]}`
}

/** Enforce validation at IPC even if renderer validation was bypassed. */
export function validateFeedbackImages(images: unknown): string | null {
  if (!Array.isArray(images)) {
    return 'Image attachments must be a list.'
  }
  if (images.length > MAX_FEEDBACK_IMAGE_COUNT) {
    return `Attach ${MAX_FEEDBACK_IMAGE_COUNT} images or fewer.`
  }
  let totalBytes = 0
  for (const image of images) {
    if (!image || typeof image !== 'object') {
      return 'Invalid image attachment.'
    }
    if (typeof image.contentType !== 'string') {
      return 'Invalid image attachment content type.'
    }
    if (!isSupportedFeedbackImageContentType(image.contentType)) {
      return 'Unsupported image type.'
    }
    if (!(image.data instanceof Uint8Array)) {
      return 'Invalid image attachment bytes.'
    }
    if (image.data.byteLength === 0) {
      return 'Image attachment is empty.'
    }
    if (image.data.byteLength > MAX_FEEDBACK_IMAGE_BYTES) {
      return `Each image must be ${MAX_FEEDBACK_IMAGE_BYTES} bytes or fewer.`
    }
    totalBytes += image.data.byteLength
  }
  if (totalBytes > MAX_FEEDBACK_IMAGE_TOTAL_BYTES) {
    return `Image attachments must total ${MAX_FEEDBACK_IMAGE_TOTAL_BYTES} bytes or fewer.`
  }
  return null
}

export function appendFeedbackImagesToFormData(
  formData: FormData,
  images: FeedbackImageAttachment[]
): void {
  for (const [index, image] of images.entries()) {
    formData.append(
      FEEDBACK_IMAGE_FORM_FIELD,
      new Blob([image.data as BlobPart], { type: image.contentType }),
      feedbackImageFilename(index, image.contentType)
    )
  }
}

/** Atomic servers omit the image field after both the text and images land. */
export async function readFeedbackImagesDelivered(response: Response): Promise<boolean> {
  try {
    const parsed: unknown = await readFetchResponseJsonWithinLimit(
      response,
      MAX_FEEDBACK_IMAGE_RESPONSE_BYTES
    )
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return false
    }
    if ('imagesDelivered' in parsed) {
      return (parsed as { imagesDelivered?: unknown }).imagesDelivered === true
    }
    return (parsed as { ok?: unknown }).ok === true
  } catch {}
  return false
}
