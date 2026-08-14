import { describe, expect, it } from 'vitest'
import { readJournalLog, readJournalSnapshotFile } from './journal-log-file'

function fileError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException
  error.code = code
  return error
}

const failWith = (code: string) => async (): Promise<string> => {
  throw fileError(code)
}

describe('journal file read errors', () => {
  it('treats only a missing snapshot or log as absent', async () => {
    await expect(readJournalSnapshotFile('/journal', failWith('ENOENT'))).resolves.toBeNull()
    await expect(readJournalLog('/journal', failWith('ENOENT'))).resolves.toEqual({
      rows: [],
      unreadable: false,
      malformed: 0
    })
  })

  it.each(['EACCES', 'EIO'])('fails closed on snapshot %s', async (code) => {
    await expect(readJournalSnapshotFile('/journal', failWith(code))).rejects.toMatchObject({
      code
    })
  })

  it.each(['EACCES', 'EIO'])('fails closed on log %s', async (code) => {
    await expect(readJournalLog('/journal', failWith(code))).rejects.toMatchObject({ code })
  })

  it('keeps malformed snapshot bytes distinct from an I/O failure', async () => {
    await expect(readJournalSnapshotFile('/journal', async () => '{')).resolves.toBeNull()
  })
})
