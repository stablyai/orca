import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_INTEGRATION_CREDENTIAL_FILE_BYTES,
  readIntegrationCredentialFileSync,
  readIntegrationCredentialFileText
} from './integration-credential-file'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function createPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-integration-credential-'))
  roots.push(root)
  return join(root, 'credential')
}

describe('integration credential file bounds', () => {
  it('accepts exact-cap credential bytes in sync and async readers', async () => {
    // Literal ceiling: sizing the fixture from the constant would pass at any value.
    expect(MAX_INTEGRATION_CREDENTIAL_FILE_BYTES).toBe(1024 * 1024)
    const filePath = createPath()
    writeFileSync(filePath, Buffer.alloc(1024 * 1024, 0x61))

    expect(readIntegrationCredentialFileSync(filePath)).toHaveLength(1024 * 1024)
    await expect(readIntegrationCredentialFileText(filePath)).resolves.toHaveLength(1024 * 1024)
  })

  it('rejects a sparse credential file beyond the cap', () => {
    const filePath = createPath()
    const file = openSync(filePath, 'w')
    ftruncateSync(file, 1024 * 1024 + 1)
    closeSync(file)

    expect(() => readIntegrationCredentialFileSync(filePath)).toThrow('exceeds')
  })
})
