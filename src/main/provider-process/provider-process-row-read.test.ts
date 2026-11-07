import { describe, expect, it } from 'vitest'
import { readPosixProcessRow } from './provider-process-row-read'

describe.runIf(process.platform !== 'win32')('readPosixProcessRow', () => {
  it('reads this process with the same start marker every time', async () => {
    const first = await readPosixProcessRow(process.pid)
    const second = await readPosixProcessRow(process.pid)
    expect(first).toMatchObject({ pid: process.pid, ppid: process.ppid })
    expect(second).toEqual(first)
  })

  it('reports a pid with no process as absent, not unverifiable', async () => {
    await expect(readPosixProcessRow(2 ** 22 + 12_345)).resolves.toBeNull()
  })
})
