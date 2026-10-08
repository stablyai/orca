import { resolve, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MAX_PENDING_OS_OPENED_DOCUMENTS, OsOpenedDocumentState } from './os-opened-documents'

// Why resolve(): the state uses the host platform by default, so fixture paths must already be
// spelled the way the host's path module normalizes them (`\n\a.md` and a drive on Windows).
const hostPath = (name: string): string => resolve(sep, 'notes', name)

describe('OsOpenedDocumentState', () => {
  it('reports no capture and does not publish when argv carries no markdown', () => {
    const state = new OsOpenedDocumentState()
    const publish = vi.fn()

    expect(state.capture(['/Applications/Orca.app/Contents/MacOS/Orca', '--serve'], publish)).toBe(
      false
    )
    expect(publish).not.toHaveBeenCalled()
    expect(state.consume()).toEqual([])
  })

  it('buffers and publishes when argv carries markdown', () => {
    const state = new OsOpenedDocumentState()
    const publish = vi.fn()
    const filePath = hostPath('a.csv')

    expect(state.capture(['/Applications/Orca.app/Contents/MacOS/Orca', filePath], publish)).toBe(
      true
    )
    expect(publish).toHaveBeenCalledTimes(1)
    expect(state.consume()).toEqual([filePath])
  })

  it('captures a single macOS open-file path', () => {
    const state = new OsOpenedDocumentState()
    const publish = vi.fn()
    const filePath = hostPath('a.tsv')

    expect(state.captureFilePaths([filePath], publish)).toBe(true)
    expect(state.captureFilePaths([hostPath('a.png')], publish)).toBe(false)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(state.consume()).toEqual([filePath])
  })

  it('does not duplicate a path captured twice', () => {
    const state = new OsOpenedDocumentState()
    const filePath = hostPath('a.csv')

    state.captureFilePaths([filePath])
    state.captureFilePaths([filePath])
    state.capture(['orca', filePath])

    expect(state.consume()).toEqual([filePath])
  })

  it('drains the buffer on consume', () => {
    const state = new OsOpenedDocumentState()
    const paths = [hostPath('a.md'), hostPath('b.md')]
    state.captureFilePaths(paths)

    expect(state.consume()).toEqual(paths)
    expect(state.consume()).toEqual([])
  })

  it('restores an undelivered batch at the front of the buffer', () => {
    const state = new OsOpenedDocumentState()
    state.captureFilePaths([hostPath('later.md')])

    state.restore([hostPath('undelivered.md')])

    expect(state.consume()).toEqual([hostPath('undelivered.md'), hostPath('later.md')])
  })

  it('caps the buffer when captures overflow it', () => {
    const state = new OsOpenedDocumentState()
    const overflow = MAX_PENDING_OS_OPENED_DOCUMENTS + 5
    const paths = Array.from({ length: overflow }, (_, index) =>
      hostPath(`file-${index}.${index % 2 === 0 ? 'csv' : 'tsv'}`)
    )

    expect(state.captureFilePaths(paths)).toBe(true)

    expect(state.consume()).toEqual(paths.slice(0, MAX_PENDING_OS_OPENED_DOCUMENTS))
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
  it('stops merging an OS file batch at the pending delivery cap', () => {
    const state = new OsOpenedDocumentState()
    const includes = vi.spyOn(Array.prototype, 'includes')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let probes: number
    try {
      state.captureFilePaths(
        Array.from({ length: 10000 }, (_, index) => resolve(`/notes/${index}.md`))
      )
      probes = includes.mock.calls.length
    } finally {
      includes.mockRestore()
      warn.mockRestore()
    }
    expect(probes).toBeLessThan(100)
    expect(state.consume()).toEqual(
      Array.from({ length: MAX_PENDING_OS_OPENED_DOCUMENTS }, (_, index) =>
        resolve(`/notes/${index}.md`)
      )
    )
  })

  // Why: the cap drops files the user explicitly asked to open. Pin which end is
  // dropped (the tail, in shell order) and that the loss is reported, not silent.
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

  it('stays silent for a batch that fits under the cap', () => {
    const state = new OsOpenedDocumentState()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      state.captureFilePaths(
        Array.from({ length: MAX_PENDING_OS_OPENED_DOCUMENTS }, (_, index) =>
          resolve(`/notes/${index}.md`)
        )
      )
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
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
