import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as secureFile from '../../../shared/secure-file'
import {
  IROH_ENDPOINT_SECRET_FILENAME,
  IrohEndpointSecretError,
  loadOrCreateIrohEndpointSecret
} from './iroh-endpoint-secret'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
    closeSync: vi.fn(actual.closeSync),
    writeFileSync: vi.fn(actual.writeFileSync)
  }
})

const actual = await vi.importActual<typeof NodeFs>('node:fs')

describe('iroh endpoint secret', () => {
  const dirs: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
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

    const raw: { v?: unknown; secretKeyB64?: unknown } = JSON.parse(
      readFileSync(join(userDataPath, IROH_ENDPOINT_SECRET_FILENAME), 'utf8')
    )
    expect(raw.v).toBe(1)
    expect(Buffer.from(String(raw.secretKeyB64), 'base64')).toHaveLength(32)
  })

  it.each(['EACCES', 'ESTALE', 'EUNKNOWN', 'ENOENT', undefined])(
    'never attempts a write after a read failure (%s)',
    (code) => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-secret-'))
      dirs.push(userDataPath)
      const first = loadOrCreateIrohEndpointSecret(userDataPath)
      const file = join(userDataPath, IROH_ENDPOINT_SECRET_FILENAME)
      const original = readFileSync(file, 'utf8')
      const write = vi.spyOn(secureFile, 'writeSecureJsonFile')
      vi.mocked(readSync).mockImplementationOnce(() => {
        throw Object.assign(new Error(`failed reading private key ${original}`), { code })
      })

      let failure: unknown
      try {
        loadOrCreateIrohEndpointSecret(userDataPath)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(IrohEndpointSecretError)
      expect(failure).toMatchObject({ operation: 'read' })
      expect(failure).not.toHaveProperty('cause')
      expect(String(failure)).not.toContain(original)
      expect(write).not.toHaveBeenCalled()
      expect(readFileSync(file, 'utf8')).toBe(original)
      expect(loadOrCreateIrohEndpointSecret(userDataPath)).toEqual(first)
    }
  )

  it.each(['open', 'harden', 'close'] as const)(
    'preserves the identity when %s fails, even with an ENOENT after opening',
    (stage) => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-secret-'))
      dirs.push(userDataPath)
      loadOrCreateIrohEndpointSecret(userDataPath)
      const file = join(userDataPath, IROH_ENDPOINT_SECRET_FILENAME)
      const original = readFileSync(file, 'utf8')
      const write = vi.spyOn(secureFile, 'writeSecureJsonFile')
      const failure = Object.assign(new Error('I/O failure'), {
        code: stage === 'open' ? 'ESTALE' : 'ENOENT'
      })
      if (stage === 'open') {
        vi.mocked(openSync).mockImplementationOnce(() => {
          throw failure
        })
      } else if (stage === 'harden') {
        vi.spyOn(secureFile, 'hardenExistingSecureFile').mockImplementationOnce(() => {
          throw failure
        })
      } else {
        vi.mocked(closeSync).mockImplementationOnce((descriptor) => {
          actual.closeSync(descriptor)
          throw failure
        })
      }

      expect(() => loadOrCreateIrohEndpointSecret(userDataPath)).toThrow(IrohEndpointSecretError)
      expect(write).not.toHaveBeenCalled()
      expect(readFileSync(file, 'utf8')).toBe(original)
    }
  )

  it('reassembles short reads before validating the saved identity', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-secret-'))
    dirs.push(userDataPath)
    const first = loadOrCreateIrohEndpointSecret(userDataPath)
    const write = vi.spyOn(secureFile, 'writeSecureJsonFile')
    vi.mocked(readSync).mockImplementationOnce((descriptor, buffer) =>
      actual.readSync(descriptor, buffer, 0, 5, null)
    )

    expect(loadOrCreateIrohEndpointSecret(userDataPath)).toEqual(first)
    expect(write).not.toHaveBeenCalled()
  })

  it.each(['{"secretKeyB64":"private-key-excerpt', 'null', '{}', 'x'.repeat(4097)])(
    'repairs readable invalid data without exposing it',
    (contents) => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-secret-'))
      dirs.push(userDataPath)
      const file = join(userDataPath, IROH_ENDPOINT_SECRET_FILENAME)
      writeFileSync(file, contents, { mode: 0o600 })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const repaired = loadOrCreateIrohEndpointSecret(userDataPath)
      expect(repaired).toHaveLength(32)
      expect(loadOrCreateIrohEndpointSecret(userDataPath)).toEqual(repaired)
      expect(warn).toHaveBeenCalledOnce()
      expect(JSON.stringify(warn.mock.calls)).not.toContain(contents)
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        v: 1,
        secretKeyB64: Buffer.from(repaired).toString('base64')
      })
    }
  )

  it('attributes an actual repair write failure without retaining private data', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-secret-'))
    dirs.push(userDataPath)
    const file = join(userDataPath, IROH_ENDPOINT_SECRET_FILENAME)
    const contents = '{"secretKeyB64":"private-key-excerpt'
    writeFileSync(file, contents, { mode: 0o600 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error(`write failed: ${contents}`), { code: 'ENOSPC' })
    })

    let failure: unknown
    try {
      loadOrCreateIrohEndpointSecret(userDataPath)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(IrohEndpointSecretError)
    expect(failure).toMatchObject({ operation: 'write' })
    expect(failure).not.toHaveProperty('cause')
    expect(String(failure)).not.toContain(contents)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-key-excerpt')
    expect(readFileSync(file, 'utf8')).toBe(contents)
  })
})
