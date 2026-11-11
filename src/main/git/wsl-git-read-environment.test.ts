import { afterEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('node:child_process', () => ({
  execFile: execFileMock
}))

import {
  getWslGitReadEnvironment,
  resetWslGitReadEnvironmentForTests
} from './wsl-git-read-environment'

describe('WSL git read environment probe', () => {
  afterEach(() => {
    resetWslGitReadEnvironmentForTests()
    execFileMock.mockReset()
  })

  it('looks up the login shell from a non-login outer sh', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback?.(null, '', '')
      return {}
    })

    await getWslGitReadEnvironment('Ubuntu')

    const args = execFileMock.mock.calls[0]?.[1] as string[]
    expect(args.slice(0, 4)).toEqual(['-d', 'Ubuntu', '--exec', 'sh'])
    expect(args[4]).toBe('-c')
    expect(args).not.toContain('-lc')
    expect(String(args.at(-1))).toContain('exec "$_orca_wsl_shell" -ilc')
  })
})
