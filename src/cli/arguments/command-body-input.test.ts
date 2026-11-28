import { afterEach, describe, expect, it, vi } from 'vitest'

import { readTextOrFileFlag } from './command-body-input'

describe('readTextOrFileFlag --body-file from a WSL shell', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    vi.unstubAllEnvs()
  })

  it('reads a typed Linux absolute path inside the caller distro', async () => {
    // The Windows CLI runs for a WSL caller whose typed paths are Linux; stub so every OS covers it.
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.stubEnv('ORCA_CLI_WSL_DISTRO', 'Orca-Test-Distro')
    const flags = new Map([['body-file', '/home/me/../me/orca-missing-reply.md']])

    const message = await readTextOrFileFlag(flags, 'C:\\src\\app', 'body', true).then(
      () => '',
      (error: Error) => error.message
    )

    expect(message).toMatch(
      /^Could not read \\\\wsl\.localhost\\Orca-Test-Distro\\home\\me\\orca-missing-reply\.md: /
    )
  })
})
