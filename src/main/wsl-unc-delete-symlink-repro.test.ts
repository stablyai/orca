import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { tryDeleteWslUncPath } from './wsl-unc-delete'

const DISTRO = 'Ubuntu'
const FIXTURE_ROOT = '/tmp/orca-wsl-vault-delete-repro/vault'
const OUTSIDE_ROOT = '/tmp/orca-wsl-vault-delete-repro/outside'
const SENTINEL = `${OUTSIDE_ROOT}/unrelated-sentinel`
const LINK = `${FIXTURE_ROOT}/linked-project`

function unc(linuxPath: string): string {
  return `\\\\wsl.localhost\\${DISTRO}${linuxPath.replaceAll('/', '\\')}`
}

function withWindows<T>(run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  return run().finally(() => {
    if (original) {
      Object.defineProperty(process, 'platform', original)
    }
  })
}

describe('WSL vault intermediate-symlink reproduction', () => {
  let removalReached: boolean
  let virtualEntries: Set<string>

  beforeEach(() => {
    removalReached = false
    virtualEntries = new Set([
      `${OUTSIDE_ROOT}/session.json`,
      `${OUTSIDE_ROOT}/session/inside`,
      SENTINEL
    ])
    execFileMock.mockReset()
    execFileMock.mockImplementation((_binary, args: string[], _options, callback) => {
      const separator = args.findIndex((arg) => arg === '--' || arg === '--exec')
      const command = args.slice(separator + 1)
      if (command[0] === 'rm') {
        removalReached = true
        callback(null, '', '')
        return
      }

      const error = Object.assign(new Error('Command failed'), { code: 65 })
      callback(error, '', 'Refusing WSL delete: symbolic-link path component')
    })
  })

  it.each([
    ['file-shaped', `${FIXTURE_ROOT}/linked-project/session.json`, false],
    ['directory-shaped', `${FIXTURE_ROOT}/linked-project/session`, true]
  ])('rejects a %s target before removal', async (_shape, target, recursive) => {
    const options = { recursive, approvedRoots: [unc(FIXTURE_ROOT)] }
    let rejection: unknown

    await withWindows(async () => {
      try {
        await tryDeleteWslUncPath(unc(target), options)
      } catch (error) {
        rejection = error
      }
    })

    expect(removalReached).toBe(false)
    expect(rejection).toEqual(
      expect.objectContaining({ message: expect.stringContaining('symbolic-link') })
    )
    expect(LINK).toBe(`${FIXTURE_ROOT}/linked-project`)
    expect(virtualEntries).toEqual(
      new Set([`${OUTSIDE_ROOT}/session.json`, `${OUTSIDE_ROOT}/session/inside`, SENTINEL])
    )
  })
})
