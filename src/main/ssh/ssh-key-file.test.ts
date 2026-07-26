import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readSshKeyFile, SSH_KEY_FILE_MAX_BYTES } from './ssh-key-file'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeKeyPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-ssh-key-'))
  roots.push(root)
  return join(root, 'id_ed25519')
}

describe('SSH key file bounds', () => {
  it('preserves ordinary key bytes', () => {
    const keyPath = makeKeyPath()
    writeFileSync(keyPath, 'private-key')

    expect(readSshKeyFile(keyPath)).toEqual(Buffer.from('private-key'))
  })

  it('rejects an oversized sparse key file', () => {
    const keyPath = makeKeyPath()
    const descriptor = openSync(keyPath, 'w')
    ftruncateSync(descriptor, SSH_KEY_FILE_MAX_BYTES + 1)
    closeSync(descriptor)

    expect(() => readSshKeyFile(keyPath)).toThrow('exceeds')
  })
})
