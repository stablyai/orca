import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readFileMock, listTargetsMock, resolveRouteMock, resolveHomeMock, unverifiableMock } =
  vi.hoisted(() => ({
    readFileMock: vi.fn(),
    listTargetsMock: vi.fn(),
    resolveRouteMock: vi.fn(),
    resolveHomeMock: vi.fn(),
    unverifiableMock: vi.fn()
  }))

vi.mock('node:fs/promises', () => ({ readFile: readFileMock }))
vi.mock('node:os', () => ({ homedir: () => '/home/local' }))
vi.mock('../ssh/ssh-target-registry', () => ({ listRegisteredSshTargets: listTargetsMock }))
vi.mock('../providers/execution-host-provider-dispatch', () => ({
  resolveFilesystemRouteForHost: resolveRouteMock
}))
vi.mock('../ipc/repos/remote-home-path', () => ({ resolveRemoteHomePath: resolveHomeMock }))
vi.mock('../ssh/ssh-channel-multiplexer', () => ({
  isSshRequestOutcomeUnverifiable: unverifiableMock
}))

import { findAntigravityCredential } from './antigravity-credential-hosts'

const NOW = 1_700_000_000_000
const CREDENTIAL = (expiry: string) =>
  JSON.stringify({ token: { access_token: 'access-1', expiry } })
const FRESH = CREDENTIAL(new Date(NOW + 60_000).toISOString())
const STALE = CREDENTIAL(new Date(NOW - 60_000).toISOString())

function sshTarget(id: string, label: string) {
  return { id, label, host: `${id}.example`, port: 22, username: 'ubuntu' }
}

function reachableRoute(readFile: ReturnType<typeof vi.fn>) {
  return { kind: 'ssh', hostId: 'ssh:box', connectionId: 'box', provider: { readFile } }
}

describe('findAntigravityCredential', () => {
  beforeEach(() => {
    readFileMock.mockReset().mockRejectedValue(new Error('ENOENT'))
    listTargetsMock.mockReset().mockReturnValue([])
    resolveRouteMock.mockReset()
    resolveHomeMock.mockReset().mockResolvedValue('/home/ubuntu')
    unverifiableMock.mockReset().mockReturnValue(false)
  })

  it('reads the Antigravity CLI path on this machine first', async () => {
    readFileMock.mockResolvedValue(FRESH)
    listTargetsMock.mockReturnValue([sshTarget('box', 'Dev box')])
    const result = await findAntigravityCredential(NOW)
    expect(result).toMatchObject({ status: 'ok', found: { hostId: 'local' } })
    expect(readFileMock).toHaveBeenCalledWith(
      '/home/local/.gemini/antigravity-cli/antigravity-oauth-token',
      'utf8'
    )
    expect(resolveRouteMock).not.toHaveBeenCalled()
  })

  it('falls through to an SSH host when this machine has no sign-in', async () => {
    const remoteRead = vi.fn().mockResolvedValue({ content: FRESH, isBinary: false })
    listTargetsMock.mockReturnValue([sshTarget('box', 'Dev box')])
    resolveRouteMock.mockReturnValue(reachableRoute(remoteRead))
    const result = await findAntigravityCredential(NOW)
    expect(result).toMatchObject({
      status: 'ok',
      found: { hostId: 'ssh:box', hostLabel: 'Dev box' }
    })
    expect(remoteRead).toHaveBeenCalledWith(
      '/home/ubuntu/.gemini/antigravity-cli/antigravity-oauth-token'
    )
  })

  it('skips targets Orca owns as runtime plumbing', async () => {
    listTargetsMock.mockReturnValue([
      { ...sshTarget('box', 'Owned'), owner: { type: 'on-demand-runtime', runtimeId: 'r1' } },
      sshTarget('runtime-ssh-1', 'Nested')
    ])
    expect(await findAntigravityCredential(NOW)).toEqual({ status: 'missing' })
    expect(resolveRouteMock).not.toHaveBeenCalled()
  })

  it('reports an expired sign-in against the host that holds it', async () => {
    readFileMock.mockResolvedValue(STALE)
    expect(await findAntigravityCredential(NOW)).toEqual({
      status: 'expired',
      hostLabel: 'this machine'
    })
  })

  it('prefers a usable remote sign-in over an expired local one', async () => {
    readFileMock.mockResolvedValue(STALE)
    listTargetsMock.mockReturnValue([sshTarget('box', 'Dev box')])
    resolveRouteMock.mockReturnValue(
      reachableRoute(vi.fn().mockResolvedValue({ content: FRESH, isBinary: false }))
    )
    expect(await findAntigravityCredential(NOW)).toMatchObject({
      status: 'ok',
      found: { hostId: 'ssh:box' }
    })
  })

  it('does not raise an error for a target the user has not connected', async () => {
    listTargetsMock.mockReturnValue([sshTarget('box', 'Dev box')])
    resolveRouteMock.mockReturnValue({
      kind: 'ssh',
      hostId: 'ssh:box',
      connectionId: 'box',
      provider: null
    })
    expect(await findAntigravityCredential(NOW)).toEqual({ status: 'missing' })
  })

  it('keeps looking when resolving a remote home throws', async () => {
    listTargetsMock.mockReturnValue([sshTarget('box', 'Dev box')])
    resolveRouteMock.mockReturnValue(reachableRoute(vi.fn()))
    resolveHomeMock.mockRejectedValue(new Error('relay gone'))
    expect(await findAntigravityCredential(NOW)).toEqual({ status: 'missing' })
  })

  it('treats a lost link as unverifiable but a real read failure as absent', async () => {
    listTargetsMock.mockReturnValue([sshTarget('box', 'Dev box')])
    resolveRouteMock.mockReturnValue(reachableRoute(vi.fn().mockRejectedValue(new Error('boom'))))

    unverifiableMock.mockReturnValue(true)
    expect(await findAntigravityCredential(NOW)).toMatchObject({ status: 'unverifiable' })

    unverifiableMock.mockReturnValue(false)
    expect(await findAntigravityCredential(NOW)).toEqual({ status: 'missing' })
  })

  it('reports missing when a host holds an unparseable blob', async () => {
    readFileMock.mockResolvedValue('not json')
    expect(await findAntigravityCredential(NOW)).toEqual({ status: 'missing' })
  })
})
