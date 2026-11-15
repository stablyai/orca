import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isMacosFocusActive } from './macos-focus-state'

describe('isMacosFocusActive', () => {
  let dir: string
  let assertionsPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-focus-'))
    assertionsPath = join(dir, 'Assertions.json')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function writeAssertions(records: unknown[]): void {
    writeFileSync(
      assertionsPath,
      JSON.stringify({
        data: [{ storeInvalidationRecords: [{}], storeAssertionRecords: records }]
      })
    )
  }

  it('reports Focus active while an assertion is live', async () => {
    writeAssertions([{ assertionUUID: 'a' }])
    await expect(isMacosFocusActive(assertionsPath, 'darwin')).resolves.toBe(true)
  })

  it('reports inactive once every assertion is invalidated', async () => {
    writeAssertions([])
    await expect(isMacosFocusActive(assertionsPath, 'darwin')).resolves.toBe(false)
  })

  it('fails open when the store is missing or malformed', async () => {
    await expect(isMacosFocusActive(assertionsPath, 'darwin')).resolves.toBe(false)
    writeFileSync(assertionsPath, '{not json')
    await expect(isMacosFocusActive(assertionsPath, 'darwin')).resolves.toBe(false)
  })

  it('never suppresses off macOS', async () => {
    writeAssertions([{ assertionUUID: 'a' }])
    await expect(isMacosFocusActive(assertionsPath, 'linux')).resolves.toBe(false)
  })
})
