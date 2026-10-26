import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import type { SshTarget } from '../../shared/ssh-types'
import {
  resolvePrivateKeys,
  withSkippedIdentityFileDetail,
  type SkippedIdentityFiles
} from './ssh-auth-resolution'
import { readSshIdentityFile } from './ssh-identity-file-read'

const isWindows = process.platform === 'win32'
let root = ''

function targetFor(identityFile: string): SshTarget {
  return { id: 't', label: 'host', host: 'example.com', port: 22, username: 'u', identityFile }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-ssh-identity-'))
  await mkdir(join(root, 'directory'))
  await writeFile(join(root, 'huge'), '')
  await truncate(join(root, 'huge'), 2 * 1024 * 1024)
  // Windows lacks mkfifo and unprivileged symlinks; exercise those sources on POSIX.
  if (!isWindows) {
    expect((await runProcess({ program: 'mkfifo', args: [join(root, 'fifo')] })).code).toBe(0)
    await symlink('/dev/zero', join(root, 'link-to-dev-zero'))
    for (const name of ['directory', 'huge', 'fifo']) {
      await symlink(join(root, name), join(root, `link-to-${name}`))
    }
  }
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('SSH identity file reads', () => {
  const cases: [string, string][] = [
    ['directory', 'it is not a regular file'],
    ['huge', 'it is larger than 1 MB'],
    ...(isWindows
      ? []
      : ([
          ['fifo', 'it is not a regular file'],
          ['link-to-dev-zero', 'it is not a regular file'],
          ['link-to-directory', 'it is not a regular file'],
          ['link-to-huge', 'it is larger than 1 MB'],
          ['link-to-fifo', 'it is not a regular file']
        ] satisfies [string, string][]))
  ]

  it.each(cases)('skips %s without reading it and names why auth failed', async (name, reason) => {
    const keyPath = join(root, name)
    const skipped: SkippedIdentityFiles = new Map()
    expect(resolvePrivateKeys(targetFor(keyPath), null, skipped)).toEqual([])
    expect((await readSshIdentityFile(keyPath)).contents).toBeNull()

    const error = withSkippedIdentityFileDetail(
      new Error('All configured authentication methods failed.'),
      skipped
    )
    expect(error).toHaveProperty(
      'message',
      `All configured authentication methods failed. Orca skipped identity file "${keyPath}" (${reason}).`
    )
  })

  it('names a missing configured key', () => {
    const skipped: SkippedIdentityFiles = new Map()
    const missing = join(root, 'missing')
    expect(resolvePrivateKeys(targetFor(missing), null, skipped)).toEqual([])
    expect([...skipped]).toEqual([[missing, 'it does not exist']])
  })

  it('leaves non-auth errors unannotated', () => {
    const skipped: SkippedIdentityFiles = new Map()
    resolvePrivateKeys(targetFor(join(root, 'directory')), null, skipped)
    const networkError = new Error('connect ECONNREFUSED')
    withSkippedIdentityFileDetail(networkError, skipped)
    expect(networkError.message).toBe('connect ECONNREFUSED')
  })
})
