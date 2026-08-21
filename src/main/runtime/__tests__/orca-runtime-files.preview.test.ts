import { describe, it, expect } from 'vitest'
import { RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES } from '../orca-runtime-files'

describe('RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES', () => {
  it('includes office open xml word (.docx)', () => {
    expect(RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES['.docx']).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
  })

  it('includes office open xml spreadsheet (.xlsx)', () => {
    expect(RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES['.xlsx']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
  })

  it('still includes existing image and pdf types', () => {
    expect(RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES['.pdf']).toBe('application/pdf')
    expect(RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES['.png']).toBe('image/png')
  })
})
