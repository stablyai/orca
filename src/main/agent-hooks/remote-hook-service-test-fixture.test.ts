import { describe, expect, it } from 'vitest'
import { createFakeSftp } from './remote-hook-service-test-fixture'

function callSftp(
  invoke: (callback: (error: unknown, value?: unknown) => void) => void
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    invoke((error, value) => (error ? reject(error) : resolve(value)))
  })
}

describe('remote hook service test fixture', () => {
  it('derives the remote directory hierarchy from seeded files', async () => {
    const { sftp } = createFakeSftp({ '/home/dev/.zcode/cli/config.json': '{}' })

    await expect(
      callSftp((callback) => sftp.readdir('/home/dev/.zcode/cli', callback as never))
    ).resolves.toEqual([{ filename: 'config.json' }])
  })

  it('rejects writes, renames, and mkdir when the target parent is absent', async () => {
    const { sftp } = createFakeSftp({ '/tmp/source': 'value' })

    await expect(
      callSftp((callback) => sftp.writeFile('/missing/file', 'x', 'utf8', callback))
    ).rejects.toMatchObject({ code: 2 })
    await expect(
      callSftp((callback) => sftp.rename('/tmp/source', '/missing/file', callback))
    ).rejects.toMatchObject({ code: 2 })
    await expect(
      callSftp((callback) => sftp.mkdir('/missing/child', callback))
    ).rejects.toMatchObject({ code: 2 })
  })
})
