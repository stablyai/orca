import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'
import { SSH_EXEC_TIMEOUT_CODE } from './ssh-relay-exec-command'

const execCommandMock = vi.hoisted(() => vi.fn())

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: execCommandMock }))

// Why: await import() lets vi.mock() register before the module under test is evaluated.
const { resolveRemoteHostNodeForAddons } = await import('./ssh-remote-node-addon-resolution')

const conn = {} as SshConnection
const facts = (version: string, napi: string): string =>
  `__ORCA_NODE_VERSION__\n${version}\n__ORCA_NAPI_VERSION__\n${napi}\n`

describe('resolveRemoteHostNodeForAddons (rung C)', () => {
  beforeEach(() => {
    execCommandMock.mockReset()
  })

  it('accepts a Node without npm and reports its version and N-API level', async () => {
    execCommandMock
      .mockResolvedValueOnce('/usr/bin/node\n')
      .mockResolvedValueOnce(facts('v18.20.4', '9'))

    await expect(resolveRemoteHostNodeForAddons(conn, 8)).resolves.toEqual({
      nodePath: '/usr/bin/node',
      facts: { version: { major: 18, minor: 20 }, napi: 9 }
    })
    expect(execCommandMock.mock.calls[1]![1]).not.toContain('npm')
    expect(execCommandMock.mock.calls[1]![1]).toContain('-p process.versions.napi')
  })

  it('skips a Node below 18 or below the addons N-API level', async () => {
    execCommandMock
      .mockResolvedValueOnce('/usr/bin/node\n/opt/n18/bin/node\n/opt/n20/bin/node\n')
      .mockResolvedValueOnce(facts('v16.20.2', '8'))
      .mockResolvedValueOnce(facts('v18.0.0', '7'))
      .mockResolvedValueOnce(facts('v20.11.1', '9'))

    await expect(resolveRemoteHostNodeForAddons(conn, 8)).resolves.toMatchObject({
      nodePath: '/opt/n20/bin/node'
    })
  })

  it('answers null when every probe answered and no Node qualified', async () => {
    execCommandMock
      .mockResolvedValueOnce('') // path probe: nothing installed
      .mockResolvedValueOnce('/bin/bash\n') // $SHELL
      .mockRejectedValueOnce(new Error('Command failed (exit 1): ')) // command -v node

    await expect(resolveRemoteHostNodeForAddons(conn, 8)).resolves.toBeNull()
  })

  it('throws rather than answering "no Node" when a probe never answered', async () => {
    const lost = Object.assign(new Error('channel lost'), { sshChannelCloseConfirmed: true })
    execCommandMock.mockResolvedValueOnce('/usr/bin/node\n').mockRejectedValueOnce(lost)

    await expect(resolveRemoteHostNodeForAddons(conn, 8)).rejects.toBe(lost)
  })

  it('throws when the login shell probe times out', async () => {
    const timeout = Object.assign(new Error('timed out'), { code: SSH_EXEC_TIMEOUT_CODE })
    execCommandMock
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('/bin/zsh\n')
      .mockRejectedValueOnce(timeout)

    await expect(resolveRemoteHostNodeForAddons(conn, 8)).rejects.toBe(timeout)
  })
})
