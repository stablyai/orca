import { describe, expect, it } from 'vitest'
import { appendFeedbackImagesToFormData } from './feedback-image-attachments'

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
