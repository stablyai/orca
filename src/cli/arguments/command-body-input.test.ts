import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { readTextOrFileFlag } from './command-body-input'

const readBodyFile = (file: string, cwd: string): Promise<string | undefined> =>
  readTextOrFileFlag(new Map([['body-file', file]]), cwd, 'body', true)

const failureMessage = (read: Promise<unknown>): Promise<string> =>
  read.then(
    () => '',
    (error: Error) => error.message
  )

describe('readTextOrFileFlag --body-file', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // The Windows CLI runs for a WSL caller whose cwd and typed paths are Linux.
  it.skipIf(process.platform !== 'win32')(
    'reads a typed Linux absolute path inside the caller WSL distro',
    async () => {
      vi.stubEnv('ORCA_CLI_WSL_DISTRO', '')
      const message = await failureMessage(
        readBodyFile('/home/me/reply.md', '\\\\wsl.localhost\\Orca-Test-Distro\\home\\me\\repo')
      )
      expect(message).toContain(
        'Could not read \\\\wsl.localhost\\Orca-Test-Distro\\home\\me\\reply.md:'
      )
      expect(message).not.toContain('C:\\home')
    }
  )

  it('resolves a relative path against a plain cwd', async () => {
    vi.stubEnv('ORCA_CLI_WSL_DISTRO', '')
    const cwd = resolve('orca-body-file-test')
    const message = await failureMessage(readBodyFile('reply.md', cwd))
    expect(message).toBe(`Could not read ${resolve(cwd, 'reply.md')}: ENOENT`)
  })

  it('preserves a native absolute path verbatim when no WSL translation applies', async () => {
    vi.stubEnv('ORCA_CLI_WSL_DISTRO', '')
    const raw =
      process.platform === 'win32'
        ? 'C:\\orca-nonexistent-link\\..\\reply.md'
        : '/orca-nonexistent-link/../reply.md'
    const message = await failureMessage(readBodyFile(raw, resolve('orca-body-file-test')))
    expect(message).toContain(`Could not read ${raw}:`)
  })
})
