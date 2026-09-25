import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcessSync } from './script-child-process.mjs'
import { getZipExtractorCommand } from './zip-extractor-command.mjs'

const directories = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function extract(bytes) {
  const directory = mkdtempSync(join(tmpdir(), "orca archive '$ "))
  directories.push(directory)
  const archive = join(directory, "source '$.zip")
  const destination = join(directory, "output '$")
  writeFileSync(archive, bytes)
  mkdirSync(destination)
  const command = getZipExtractorCommand(archive, destination)
  const result = runProcessSync({ program: command.file, args: command.args, timeoutMs: 120_000 })
  return { result, destination }
}

describe('native archive extraction', () => {
  it('extracts through paths containing spaces, apostrophes and shell characters', () => {
    const { result, destination } = extract(
      Buffer.from(
        'UEsDBBQAAAAAAI1iOF16rk6zGAAAABgAAAALAAAAcGF5bG9hZC50eHR2ZXJpZmllZCBhcmNoaXZlIHBheWxvYWRQSwECFAMUAAAAAACNYjhdeq5OsxgAAAAYAAAACwAAAAAAAAAAAAAAgAEAAAAAcGF5bG9hZC50eHRQSwUGAAAAAAEAAQA5AAAAQQAAAAAA',
        'base64'
      )
    )
    expect(result.code, result.stderr).toBe(0)
    expect(readFileSync(join(destination, 'payload.txt'), 'utf8')).toBe('verified archive payload')
  })

  it('fails on a malformed archive', () => {
    const { result } = extract('invalid archive')
    expect(result.code).not.toBe(0)
  })
})
