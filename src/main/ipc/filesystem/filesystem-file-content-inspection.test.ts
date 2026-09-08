import { describe, expect, it } from 'vitest'
import { PREVIEWABLE_BINARY_MIME_TYPES } from './filesystem-file-content-inspection'

describe('PREVIEWABLE_BINARY_MIME_TYPES', () => {
  it('maps epub to its zip-container mime type so fs:readFile returns its bytes', () => {
    expect(PREVIEWABLE_BINARY_MIME_TYPES['.epub']).toBe('application/epub+zip')
  })
})
