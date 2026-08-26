import { describe, expect, it, vi } from 'vitest'

vi.mock('fs', () => ({ existsSync: vi.fn(), readFileSync: vi.fn() }))
vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn() }))
vi.mock('./ssh-connection-utils', () => ({ shellEscape: (s: string) => `'${s}'` }))

import { execCommand } from './ssh-relay-deploy-helpers'
import { gcOldRelayVersions } from './ssh-relay-versioned-install'
import type { SshConnection } from './ssh-connection'

const mockExec = vi.mocked(execCommand)
const conn = {} as SshConnection

describe('gcOldRelayVersions orphan reclamation (#13614)', () => {
  it('reclaims a sibling after retiring its orphaned live relay', async () => {
    mockExec
      .mockResolvedValueOnce('relay-0.1.0+aaa\nrelay-0.1.0+bbb\n')
      .mockResolvedValueOnce('OPEN')
      .mockResolvedValueOnce('COMPLETE')
      .mockResolvedValueOnce('ALIVE')
      .mockResolvedValueOnce('RETIRED')
      .mockResolvedValueOnce('DEAD')
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('OPEN')
      .mockResolvedValueOnce('COMPLETE')
      .mockResolvedValueOnce('DEAD')
      .mockResolvedValueOnce('OWNED')
      .mockResolvedValueOnce('MOVED')
      .mockResolvedValueOnce('RELEASED')
      .mockResolvedValueOnce('')

    await gcOldRelayVersions(conn, '/home/u', '/home/u/.orca-remote/relay-0.1.0+bbb')

    const commands = mockExec.mock.calls.map(([, command]) => command)
    const retireCommand = commands.find((command) => command.includes('kill -TERM'))
    expect(retireCommand).toContain("dir='/home/u/.orca-remote/relay-0.1.0+aaa'")
    expect(retireCommand).not.toContain('kill -KILL')
    expect(commands.at(-1)).toContain('relay-0.1.0+aaa.gc-tombstone')
  })
})
