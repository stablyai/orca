import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RuntimeHostDescriptorSchema } from '../../../../shared/remote-runtime/host-status/runtime-host-descriptor'
import { HOST_INSTALLATION_FILENAME, loadOrCreateHostInstallationId } from './host-descriptor'

function profile(): string {
  return mkdtempSync(join(tmpdir(), 'orca-host-descriptor-'))
}

function storedId(userDataPath: string): unknown {
  return JSON.parse(readFileSync(join(userDataPath, HOST_INSTALLATION_FILENAME), 'utf8'))
    .installationId
}

describe('loadOrCreateHostInstallationId', () => {
  it('concurrent creators all return the one id that was stored', async () => {
    const userDataPath = profile()
    const ids = await Promise.all(
      Array.from({ length: 4 }, () => loadOrCreateHostInstallationId(userDataPath))
    )
    expect(new Set(ids).size).toBe(1)
    expect(storedId(userDataPath)).toBe(ids[0])
  })

  it('concurrent repairs of a malformed file never fork the id', async () => {
    const userDataPath = profile()
    writeFileSync(join(userDataPath, HOST_INSTALLATION_FILENAME), '{not json')
    const ids = await Promise.all(
      Array.from({ length: 4 }, () => loadOrCreateHostInstallationId(userDataPath))
    )
    expect(new Set(ids).size).toBe(1)
    expect(RuntimeHostDescriptorSchema.shape.installationId.safeParse(ids[0]).success).toBe(true)
    expect(storedId(userDataPath)).toBe(ids[0])
  })
})
