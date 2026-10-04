import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcessSync } from './script-child-process.mjs'
import { getZipExtractorCommand } from './zip-extractor-command.mjs'

const directories = []
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
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
  it('uses the system archive reader on Windows unless an override is configured', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.stubEnv('SystemRoot', 'C:\\Windows')
    vi.stubEnv('ORCA_UNZIP_BIN', '')
    expect(getZipExtractorCommand('source.zip', 'output')).toEqual({
      file: join('C:\\Windows', 'System32', 'tar.exe'),
      args: ['-xf', 'source.zip', '-C', 'output'],
      label: 'tar'
    })
    vi.stubEnv('ORCA_UNZIP_BIN', 'C:\\tools\\unzip.exe')
    expect(getZipExtractorCommand("source '$.zip", "output '$")).toEqual({
      file: 'C:\\tools\\unzip.exe',
      args: ['-q', "source '$.zip", '-d', "output '$"],
      label: 'unzip'
    })
  })

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
