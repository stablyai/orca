import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { setSecretStore } from '../../shared/secure-storage/secret-store'
import { createIntegrationTokenFileCache } from './integration-token-file-cache'

let directory = ''
afterEach(() => rmSync(directory, { recursive: true, force: true }))

it.each([129, 2000])(
  'completes %i concurrent credential reads without eviction retries',
  async (count) => {
    directory = mkdtempSync(join(tmpdir(), 'orca-token-file-cache-progress-'))
    const decrypt = vi.fn((value: Buffer) => value.toString('utf8'))
    setSecretStore({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: decrypt,
      describeProtectionGap: () => null
    })
    const filePath = (id: string) => join(directory, `${id}.enc`)
    const cache = createIntegrationTokenFileCache({ service: 'Jira', filePath })
    const ids = Array.from({ length: count }, (_, index) => `site-${index}`)
    for (const id of ids) {
      writeFileSync(filePath(id), 'saved-token')
    }
    expect(await Promise.all(ids.map((id) => cache.read(id)))).toEqual(
      Array(count).fill('saved-token')
    )
    expect(decrypt).toHaveBeenCalledTimes(count)
  }
)
