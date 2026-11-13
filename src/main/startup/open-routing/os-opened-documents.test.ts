import { resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OsOpenedDocumentState } from './os-opened-documents'

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
})
