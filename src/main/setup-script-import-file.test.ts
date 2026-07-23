import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFileReadTooLargeError } from '../shared/node-bounded-file-reader'
import {
  isSetupScriptImportTextWithinLimit,
  readSetupScriptImportFile,
  SETUP_SCRIPT_IMPORT_FILE_MAX_BYTES
} from './setup-script-import-file'

describe('setup script import file bounds', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function makeFile(contents: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-setup-script-import-'))
    roots.push(root)
    const filePath = join(root, 'config.json')
    await writeFile(filePath, contents)
    return filePath
  }

  it('preserves ordinary configuration text', async () => {
    const filePath = await makeFile('{"setup":"pnpm install"}')

    await expect(readSetupScriptImportFile(filePath)).resolves.toBe('{"setup":"pnpm install"}')
  })

  it('rejects an oversized sparse local configuration', async () => {
    const filePath = await makeFile('x')
    await truncate(filePath, SETUP_SCRIPT_IMPORT_FILE_MAX_BYTES + 1)

    await expect(readSetupScriptImportFile(filePath)).rejects.toBeInstanceOf(
      NodeFileReadTooLargeError
    )
  })

  it('measures remote configuration strings by UTF-8 bytes', () => {
    expect(isSetupScriptImportTextWithinLimit('a'.repeat(SETUP_SCRIPT_IMPORT_FILE_MAX_BYTES))).toBe(
      true
    )
    expect(
      isSetupScriptImportTextWithinLimit('a'.repeat(SETUP_SCRIPT_IMPORT_FILE_MAX_BYTES + 1))
    ).toBe(false)
    expect(
      isSetupScriptImportTextWithinLimit('é'.repeat(SETUP_SCRIPT_IMPORT_FILE_MAX_BYTES / 2))
    ).toBe(true)
    expect(
      isSetupScriptImportTextWithinLimit('é'.repeat(SETUP_SCRIPT_IMPORT_FILE_MAX_BYTES / 2 + 1))
    ).toBe(false)
  })
})
