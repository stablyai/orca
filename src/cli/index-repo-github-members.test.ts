import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { callMock, remoteMock } = vi.hoisted(() => ({
  callMock: vi.fn(),
  remoteMock: vi.fn(() => false)
}))

vi.mock('./runtime-client', async () => {
  const errors = await import('./runtime/types.js')
  return {
    ...errors,
    RuntimeClient: class {
      readonly isRemote = remoteMock()
      call = callMock
    }
  }
})

import { main } from './index'
import { okFixture } from './test-fixtures'

const member = {
  name: 'Alice',
  deviceIds: ['laptop', 'phone'],
  allowedAccounts: [{ host: 'github.example.com:8443', user: 'alice' }]
}

describe('repo GitHub members CLI', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-github-members-'))
    callMock.mockReset().mockResolvedValue(
      okFixture('req', {
        enabled: true,
        isOwner: true,
        allowedAccounts: [],
        participants: [],
        devices: []
      })
    )
    remoteMock.mockReturnValue(false)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    process.exitCode = undefined
  })

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true })
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('saves a member from a relative JSON file without splitting enterprise host ports', async () => {
    writeFileSync(join(directory, 'member.json'), JSON.stringify({ ...member, id: 'alice-id' }))
    await main(
      ['repo', 'github-member-save', '--repo', 'id:r1', '--file', 'member.json', '--json'],
      directory
    )
    expect(callMock).toHaveBeenCalledWith('github.participants.save', {
      repo: 'id:r1',
      ...member,
      id: 'alice-id'
    })
    expect(process.exitCode).toBeUndefined()
  })

  it.each([
    { ...member, token: 'not-a-real-secret' },
    {
      ...member,
      allowedAccounts: [{ host: 'github.com', user: 'alice', token: 'not-a-real-secret' }]
    },
    { ...member, deviceIds: 'laptop' }
  ])('rejects invalid member files before RPC', async (value) => {
    writeFileSync(join(directory, 'member.json'), JSON.stringify(value))
    await main(
      ['repo', 'github-member-save', '--repo', 'id:r1', '--file', 'member.json', '--json'],
      directory
    )
    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain('not-a-real-secret')
  })

  it.each(['environment', 'pairing-code'])(
    'refuses --%s before reading an admin file',
    async (flag) => {
      await main(
        [
          'repo',
          'github-member-save',
          '--repo',
          'id:r1',
          '--file',
          'missing.json',
          `--${flag}`,
          'remote',
          '--json'
        ],
        directory
      )
      expect(callMock).not.toHaveBeenCalled()
      expect(JSON.stringify(vi.mocked(console.log).mock.calls)).toContain('does not retarget')
    }
  )

  it('refuses an implicitly remote admin connection', async () => {
    remoteMock.mockReturnValue(true)
    await main(
      ['repo', 'github-members-mode', '--repo', 'id:r1', '--mode', 'enabled', '--json'],
      directory
    )
    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('reports malformed JSON without echoing its content', async () => {
    writeFileSync(join(directory, 'member.json'), '{not-a-real-secret')
    await main(
      ['repo', 'github-member-save', '--repo', 'id:r1', '--file', 'member.json', '--json'],
      directory
    )
    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain('not-a-real-secret')
  })

  it('enables shared repo policy and reports its scope', async () => {
    await main(['repo', 'github-members-mode', '--repo', 'id:r1', '--mode', 'enabled'], directory)
    expect(callMock).toHaveBeenCalledWith('github.participants.setEnabled', {
      repo: 'id:r1',
      enabled: true
    })
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).toContain(
      'Shared repo GitHub member policy: enabled'
    )
  })

  it('rejects invalid mode before RPC', async () => {
    await main(
      ['repo', 'github-members-mode', '--repo', 'id:r1', '--mode', 'yes', '--json'],
      directory
    )
    expect(callMock).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })

  it('removes by member ID', async () => {
    await main(
      ['repo', 'github-member-remove', '--repo', 'id:r1', '--id', 'alice-id', '--json'],
      directory
    )
    expect(callMock).toHaveBeenCalledWith('github.participants.remove', {
      repo: 'id:r1',
      id: 'alice-id'
    })
  })

  it('allows paired clients to inspect their own status', async () => {
    remoteMock.mockReturnValue(true)
    await main(['repo', 'github-members', '--repo', 'id:r1', '--json'], directory)
    expect(callMock).toHaveBeenCalledWith('github.participants.status', { repo: 'id:r1' })
  })
})
