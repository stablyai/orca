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
    const filePath = createPath()
    writeFileSync(filePath, Buffer.alloc(MAX_INTEGRATION_CREDENTIAL_FILE_BYTES, 0x61))

    expect(readIntegrationCredentialFileSync(filePath)).toHaveLength(
      MAX_INTEGRATION_CREDENTIAL_FILE_BYTES
    )
    await expect(readIntegrationCredentialFileText(filePath)).resolves.toHaveLength(
      MAX_INTEGRATION_CREDENTIAL_FILE_BYTES
    )
  })

  it('rejects a sparse credential file beyond the cap', () => {
    const filePath = createPath()
    const file = openSync(filePath, 'w')
    ftruncateSync(file, MAX_INTEGRATION_CREDENTIAL_FILE_BYTES + 1)
    closeSync(file)

    expect(() => readIntegrationCredentialFileSync(filePath)).toThrow('exceeds')
  })
})
