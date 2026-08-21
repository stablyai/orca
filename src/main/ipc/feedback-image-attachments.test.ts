import { describe, expect, it } from 'vitest'
import {
  MAX_FEEDBACK_IMAGE_BYTES,
  MAX_FEEDBACK_IMAGE_COUNT,
  appendFeedbackImagesToFormData,
  feedbackImageFilename,
  isSupportedFeedbackImageContentType,
  validateFeedbackImages
} from './feedback-image-attachments'

function image(contentType: string, bytes = 4): { contentType: string; data: Uint8Array } {
  return { contentType, data: new Uint8Array(bytes).fill(1) }
}

describe('isSupportedFeedbackImageContentType', () => {
  it.each(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])('accepts %s', (contentType) => {
    expect(isSupportedFeedbackImageContentType(contentType)).toBe(true)
  })

  it.each(['image/bmp', 'image/svg+xml', 'application/pdf', ''])('rejects %s', (contentType) => {
    expect(isSupportedFeedbackImageContentType(contentType)).toBe(false)
  })

  // Why: the allow-list is an object literal, so a prototype member must not
  // pass as a content type and get spliced into the upload filename.
  it.each(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'])(
    'rejects the inherited member %s',
    (contentType) => {
      expect(isSupportedFeedbackImageContentType(contentType)).toBe(false)
      expect(validateFeedbackImages([image(contentType)])).toBe('Unsupported image type.')
    }
  )
})

describe('feedbackImageFilename', () => {
  it.each([
    ['image/png', 'feedback-image-1.png'],
    ['image/jpeg', 'feedback-image-1.jpg'],
    ['image/webp', 'feedback-image-1.webp'],
    ['image/gif', 'feedback-image-1.gif']
  ])('names a %s attachment %s', (contentType, expected) => {
    expect(feedbackImageFilename(0, contentType)).toBe(expected)
  })

  it('numbers attachments from one', () => {
    expect(feedbackImageFilename(3, 'image/png')).toBe('feedback-image-4.png')
  })
})

describe('appendFeedbackImagesToFormData', () => {
  it('frames only the exact typed-array view', async () => {
    const backing = new Uint8Array([0, 1, 2, 3])
    const view = backing.subarray(1, 3)
    const formData = new FormData()

    appendFeedbackImagesToFormData(formData, [{ contentType: 'image/png', data: view }])

    const blob = formData.get('feedbackImage')
    expect(blob).toBeInstanceOf(Blob)
    expect(new Uint8Array(await (blob as Blob).arrayBuffer())).toEqual(new Uint8Array([1, 2]))
  })
})

describe('validateFeedbackImages', () => {
  it('accepts a full batch of supported images', () => {
    expect(
      validateFeedbackImages(
        Array.from({ length: MAX_FEEDBACK_IMAGE_COUNT }, () => image('image/png'))
      )
    ).toBeNull()
  })

  it('rejects more than the supported count', () => {
    expect(
      validateFeedbackImages(
        Array.from({ length: MAX_FEEDBACK_IMAGE_COUNT + 1 }, () => image('image/png'))
      )
    ).toBe(`Attach ${MAX_FEEDBACK_IMAGE_COUNT} images or fewer.`)
  })

  it('rejects malformed attachment collections and byte payloads', () => {
    expect(validateFeedbackImages('image/png')).toBe('Image attachments must be a list.')
    expect(validateFeedbackImages([null])).toBe('Invalid image attachment.')
    expect(validateFeedbackImages([{ contentType: 'image/png', data: '8388608' }])).toBe(
      'Invalid image attachment bytes.'
    )
  })

  it('rejects an empty attachment', () => {
    expect(validateFeedbackImages([image('image/png', 0)])).toBe('Image attachment is empty.')
  })

  it('rejects an attachment over the byte cap', () => {
    expect(validateFeedbackImages([image('image/png', MAX_FEEDBACK_IMAGE_BYTES + 1)])).toBe(
      `Each image must be ${MAX_FEEDBACK_IMAGE_BYTES} bytes or fewer.`
    )
  })
})
