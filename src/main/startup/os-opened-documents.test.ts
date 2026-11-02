import { resolve, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MAX_PENDING_OS_OPENED_DOCUMENTS, OsOpenedDocumentState } from './os-opened-documents'

// Normalize fixture paths with host rules, including Windows drive/separators.
const hostPath = (name: string): string => resolve(sep, 'notes', name)

describe('OsOpenedDocumentState', () => {
  it('does not duplicate a path captured twice', () => {
    const state = new OsOpenedDocumentState()
    const filePath = hostPath('a.csv')

    state.captureFilePaths([filePath])
    state.captureFilePaths([filePath])
    state.capture(['orca', filePath])

    expect(state.consume()).toEqual([filePath])
  })

  it('restores an undelivered batch at the front of the buffer', () => {
    const state = new OsOpenedDocumentState()
    state.captureFilePaths([hostPath('later.md')])

    state.restore([hostPath('undelivered.md')])

    expect(state.consume()).toEqual([hostPath('undelivered.md'), hostPath('later.md')])
  })

  it('caps the buffer when a restore overflows it', () => {
    const state = new OsOpenedDocumentState()
    state.captureFilePaths([hostPath('pending.md')])
    const restored = Array.from({ length: MAX_PENDING_OS_OPENED_DOCUMENTS }, (_, index) =>
      hostPath(`restored-${index}.md`)
    )

    state.restore(restored)

    const pending = state.consume()
    expect(pending).toHaveLength(MAX_PENDING_OS_OPENED_DOCUMENTS)
    expect(pending).toEqual(restored)
  })
})

describe('OsOpenedDocumentState delivery cap', () => {
  // Queue limits drop explicit user selections; pin shell order and require diagnostics for lost tail entries.
  it('keeps the first paths in shell order and reports the dropped tail', () => {
    const state = new OsOpenedDocumentState()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const total = MAX_PENDING_OS_OPENED_DOCUMENTS + 8
    const paths = Array.from({ length: total }, (_, index) =>
      resolve(`/notes/${String(index).padStart(3, '0')}.md`)
    )
    try {
      expect(state.captureFilePaths(paths)).toBe(true)
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`Dropped 8 of ${total} OS-opened documents`)
      )
    } finally {
      warn.mockRestore()
    }
    expect(state.consume()).toEqual(paths.slice(0, MAX_PENDING_OS_OPENED_DOCUMENTS))
  })

  it('reports a drop when an already-full queue rejects a later batch', () => {
    const state = new OsOpenedDocumentState()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      state.captureFilePaths(
        Array.from({ length: MAX_PENDING_OS_OPENED_DOCUMENTS }, (_, index) =>
          resolve(`/first/${index}.md`)
        )
      )
      expect(warn).not.toHaveBeenCalled()
      state.captureFilePaths([resolve('/second/a.md'), resolve('/second/b.md')])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Dropped 2 of 2'))
    } finally {
      warn.mockRestore()
    }
    expect(state.consume()).toEqual(
      Array.from({ length: MAX_PENDING_OS_OPENED_DOCUMENTS }, (_, index) =>
        resolve(`/first/${index}.md`)
      )
    )
  })
})
