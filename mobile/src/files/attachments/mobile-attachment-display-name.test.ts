import { describe, expect, it } from 'vitest'
import { shortAttachmentDisplayName } from './mobile-attachment-display-name'

describe('shortAttachmentDisplayName', () => {
  it('names a file by its own name and trims a long one in the middle, keeping the extension', () => {
    expect(shortAttachmentDisplayName('/store/x/notes.txt')).toBe('notes.txt')
    expect(
      shortAttachmentDisplayName('/store/x/ScreenRecording_11-17-2026 19-45-47_1.mp4', 30)
    ).toBe('ScreenRecording_11-1…-47_1.mp4')
    expect(shortAttachmentDisplayName('/store/x/QuarterlyRevenueForecast2026.numbers', 22)).toBe(
      'Quarterly…2026.numbers'
    )
  })

  it('gives no caption for a generated name or an inline image address', () => {
    expect(shortAttachmentDisplayName('/tmp/orca-paste-17950-ab/image.png')).toBe('image.png')
    expect(shortAttachmentDisplayName('/tmp/orca-paste-1795090823948-165d.jpg')).toBeNull()
    expect(shortAttachmentDisplayName('data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAA/Z')).toBeNull()
  })
})
