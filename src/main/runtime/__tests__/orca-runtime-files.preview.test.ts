import { describe, it, expect } from 'vitest'
import { RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES } from '../orca-runtime-files'
import { PREVIEWABLE_BINARY_MIME_TYPES } from '../../../shared/previewable-binary-mime-types'

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

  it('agrees with the shared whitelist on every extension', () => {
    // Why: local IPC, SSH relay, and runtime host all import from the same
    // shared module so a .docx in a remote worktree uses the same MIME as one
    // opened locally. Drift here means remote previews silently fall back to
    // "Binary file — cannot display".
    for (const [ext, mime] of Object.entries(PREVIEWABLE_BINARY_MIME_TYPES)) {
      expect(RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES[ext]).toBe(mime)
    }
  })
})
