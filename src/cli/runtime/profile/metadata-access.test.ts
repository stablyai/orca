import * as fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getCliStatus } from '../status/status'
import { readMetadata, tryReadMetadata } from './metadata'

vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof fs>()) }))

const userDataPath = '/orca-profile'

function failMetadataRead(code: string): void {
  vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
    throw Object.assign(new Error(code), { code })
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runtime metadata read failures', () => {
  it('reports a sandbox-denied read as runtime_access_denied, not a stopped app', () => {
    failMetadataRead('EPERM')
    expect(() => readMetadata(userDataPath)).toThrow(
      expect.objectContaining({
        code: 'runtime_access_denied',
        data: expect.objectContaining({ systemCode: 'EPERM' })
      })
    )
  })

  it('keeps a denied read soft for status and offline admission callers', async () => {
    failMetadataRead('EACCES')
    expect(tryReadMetadata(userDataPath)).toBeNull()
    await expect(getCliStatus(userDataPath)).resolves.toMatchObject({
      ok: true,
      result: { app: { running: false }, runtime: { state: 'not_running' } }
    })
  })

  it('keeps a missing metadata file on the not-running path', async () => {
    failMetadataRead('ENOENT')
    expect(() => readMetadata(userDataPath)).toThrow(
      expect.objectContaining({ code: 'runtime_unavailable' })
    )
    await expect(getCliStatus(userDataPath)).resolves.toMatchObject({
      ok: true,
      result: { app: { running: false }, runtime: { state: 'not_running' } }
    })
  })
})
