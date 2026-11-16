import { describe, expect, it } from 'vitest'
import {
  appendFeedbackImagesToFormData,
  isSupportedFeedbackImageContentType,
  validateFeedbackImages
} from './feedback-image-attachments'

function image(contentType: string, bytes = 4): { contentType: string; data: Uint8Array } {
  return { contentType, data: new Uint8Array(bytes).fill(1) }
}

describe('isSupportedFeedbackImageContentType', () => {
  // Prototype members must not become accepted MIME types and filename extensions.
  it.each(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'])(
    'rejects the inherited member %s',
    (contentType) => {
      expect(isSupportedFeedbackImageContentType(contentType)).toBe(false)
      expect(validateFeedbackImages([image(contentType)])).toBe('Unsupported image type.')
    }
  )
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
})
