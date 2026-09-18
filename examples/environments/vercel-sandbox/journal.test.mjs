import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openJournal } from './journal.mjs'

test('failed lock metadata write closes the descriptor and permits a retry', (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'orca-journal-write-failure-'))
  const id = randomUUID()
  const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' })
  let descriptor
  const write = t.mock.method(fs, 'writeFileSync', (fd) => {
    descriptor = fd
    throw failure
  })
  syncBuiltinESMExports()
  try {
    assert.throws(
      () => openJournal(directory, id, { phase: 'intent' }),
      (error) => error === failure
    )
  } finally {
    write.mock.restore()
    syncBuiltinESMExports()
  }
  try {
    assert.equal(fs.existsSync(join(directory, `${id}.json.lock`)), false)
    assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' })
    const journal = openJournal(directory, id, { phase: 'intent' })
    try {
      journal.save({ phase: 'created' })
      assert.equal(journal.value.phase, 'created')
    } finally {
      journal.close()
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
