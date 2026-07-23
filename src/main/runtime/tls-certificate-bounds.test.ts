import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const execFileSyncMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }))

import { loadOrCreateTlsCertificate } from './tls-certificate'

const CERTIFICATE = '-----BEGIN CERTIFICATE-----\nYQ==\n-----END CERTIFICATE-----\n'
const PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nYg==\n-----END PRIVATE KEY-----\n'
const roots: string[] = []

beforeEach(() => {
  execFileSyncMock.mockImplementation((_command: string, args: string[]) => {
    const keyIndex = args.indexOf('-keyout')
    const certIndex = args.indexOf('-out')
    writeFileSync(args[keyIndex + 1], PRIVATE_KEY)
    writeFileSync(args[certIndex + 1], CERTIFICATE)
  })
})

afterEach(() => {
  execFileSyncMock.mockReset()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeUserDataPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-tls-bounds-'))
  roots.push(root)
  return root
}

describe('TLS certificate file bounds', () => {
  it('preserves existing ordinary certificate material', () => {
    const userDataPath = makeUserDataPath()
    writeFileSync(join(userDataPath, 'orca-tls-cert.pem'), CERTIFICATE)
    writeFileSync(join(userDataPath, 'orca-tls-key.pem'), PRIVATE_KEY)

    expect(loadOrCreateTlsCertificate(userDataPath)).toMatchObject({
      cert: CERTIFICATE,
      key: PRIVATE_KEY
    })
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it('regenerates instead of retaining an oversized sparse PEM file', () => {
    const userDataPath = makeUserDataPath()
    const certPath = join(userDataPath, 'orca-tls-cert.pem')
    const descriptor = openSync(certPath, 'w')
    ftruncateSync(descriptor, 1024 * 1024 + 1)
    closeSync(descriptor)
    writeFileSync(join(userDataPath, 'orca-tls-key.pem'), PRIVATE_KEY)

    expect(loadOrCreateTlsCertificate(userDataPath)).toMatchObject({
      cert: CERTIFICATE,
      key: PRIVATE_KEY
    })
    expect(execFileSyncMock).toHaveBeenCalledOnce()
  })
})
