import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  IROH_ENDPOINT_SECRET_FILENAME,
  loadOrCreateIrohEndpointSecret
} from './iroh-endpoint-secret'

describe('iroh endpoint secret', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('creates a 32-byte secret and reuses it on later loads', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-secret-'))
    dirs.push(userDataPath)

    const first = loadOrCreateIrohEndpointSecret(userDataPath)
    expect(first).toHaveLength(32)
    const second = loadOrCreateIrohEndpointSecret(userDataPath)
    expect(second).toEqual(first)

    const raw = JSON.parse(
      readFileSync(join(userDataPath, IROH_ENDPOINT_SECRET_FILENAME), 'utf8')
    ) as { v: number; secretKeyB64: string }
    expect(raw.v).toBe(1)
    expect(Buffer.from(raw.secretKeyB64, 'base64')).toHaveLength(32)
  })
})
