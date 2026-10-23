import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectHostSetup } from '../shared/project-types'
import { RuntimeClient } from './runtime-client'
import { resolveProjectCreateTarget } from './worktree-project-target'

function readySetup(overrides: Partial<ProjectHostSetup> = {}): ProjectHostSetup {
  return {
    id: 'setup-a',
    projectId: 'github:stablyai/orca',
    hostId: 'local',
    repoId: 'repo-a',
    path: '/repo/a',
    displayName: 'Orca',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function clientReturning(setups: ProjectHostSetup[]): RuntimeClient {
  const client = new RuntimeClient('/tmp/orca-cli-project-target-test', 1000, null, null)
  vi.spyOn(client, 'call').mockResolvedValue({
    id: 'setups',
    ok: true,
    result: { setups },
    _meta: { runtimeId: 'test-runtime' }
  })
  return client
}

function projectFlags(host?: string): Map<string, string | boolean> {
  const flags = new Map<string, string | boolean>([['project', 'github:stablyai/orca']])
  if (host) {
    flags.set('host', host)
  }
  return flags
}

afterEach(() => vi.restoreAllMocks())

describe('project checkout selection', () => {
  it.each([undefined, 'local', 'runtime:gpu'])(
    'refuses same-host checkout ambiguity with host %s in either registration order',
    async (host) => {
      const setups = [
        readySetup(),
        readySetup({ id: 'setup-b', repoId: 'repo-b', path: '/repo/b' })
      ]
      for (const ordered of [setups, setups.toReversed()]) {
        const failure = resolveProjectCreateTarget(projectFlags(host), clientReturning(ordered))
        await expect(failure).rejects.toThrow('2 ready setups')
        await expect(failure).rejects.toThrow('setup-a  /repo/a')
        await expect(failure).rejects.toThrow('setup-b  /repo/b')
      }
    }
  )

  it('keeps an exact runtime host authoritative over local fallback rows', async () => {
    const client = clientReturning([
      readySetup(),
      readySetup({ id: 'setup-b' }),
      readySetup({ id: 'setup-exact', repoId: 'repo-exact', hostId: 'runtime:gpu' })
    ])
    await expect(
      resolveProjectCreateTarget(projectFlags('runtime:gpu'), client)
    ).resolves.toMatchObject({
      repoSelector: 'id:repo-exact',
      repoHostId: 'runtime:gpu'
    })
  })

  it('refuses ambiguity among exact runtime matches rather than falling back to local', async () => {
    const client = clientReturning([
      readySetup(),
      readySetup({ id: 'remote-a', hostId: 'runtime:gpu' }),
      readySetup({ id: 'remote-b', hostId: 'runtime:gpu' })
    ])
    await expect(resolveProjectCreateTarget(projectFlags('runtime:gpu'), client)).rejects.toThrow(
      '2 ready setups on runtime:gpu'
    )
  })

  it('selects a setup by id and host without discarding repo host qualification', async () => {
    const client = clientReturning([
      readySetup({ id: 'same-id', repoId: 'same-repo' }),
      readySetup({ id: 'same-id', repoId: 'same-repo', hostId: 'runtime:gpu' })
    ])
    const flags = new Map<string, string | boolean>([
      ['project-host-setup', 'same-id'],
      ['host', 'runtime:gpu']
    ])
    await expect(resolveProjectCreateTarget(flags, client)).resolves.toMatchObject({
      repoSelector: 'id:same-repo',
      repoHostId: 'runtime:gpu'
    })
    flags.delete('host')
    await expect(resolveProjectCreateTarget(flags, client)).rejects.toThrow('2 hosts')
  })

  it('does not substitute a ready sibling for an unavailable explicit setup', async () => {
    const client = clientReturning([
      readySetup({ id: 'unavailable', setupState: 'error' }),
      readySetup({ id: 'sibling' })
    ])
    await expect(
      resolveProjectCreateTarget(new Map([['project-host-setup', 'unavailable']]), client)
    ).rejects.toThrow('not ready or was not found')
  })

  it('does not reinterpret an unavailable raw id as a ready escaped id', async () => {
    const client = clientReturning([
      readySetup({ id: 'setup\\u000a', setupState: 'error' }),
      readySetup({ id: 'setup\n' })
    ])
    await expect(
      resolveProjectCreateTarget(new Map([['project-host-setup', 'setup\\u000a']]), client)
    ).rejects.toThrow('not ready or was not found')
  })

  it.each([
    ['space', 'two words', 'two words'],
    ['shell syntax', '$(command)%USERPROFILE%', '$(command)%USERPROFILE%'],
    ['C0', 'setup\n', 'setup\\u000a'],
    ['C1', 'setup\u009b', 'setup\\u009b'],
    ['Arabic letter mark', 'setup\u061c', 'setup\\u061c'],
    ['zero-width', 'setup\u200b', 'setup\\u200b'],
    ['line separator', 'setup\u2028', 'setup\\u2028'],
    ['bidi override', 'setup\u202e', 'setup\\u202e'],
    ['word joiner', 'setup\u2060', 'setup\\u2060'],
    ['BOM', 'setup\ufeff', 'setup\\ufeff'],
    ['backslash', 'setup\\value', 'setup\\\\value']
  ])('prints and resolves terminal-safe %s metadata', async (_name, id, escapedId) => {
    const client = clientReturning([
      readySetup({ id, path: `/repo/${id}` }),
      readySetup({ id: 'other', repoId: 'repo-other' })
    ])
    const failure = resolveProjectCreateTarget(projectFlags(), client)
    await expect(failure).rejects.toThrow(
      `--project-host-setup-base64=${Buffer.from(id).toString('base64url')}  /repo/${escapedId}`
    )
    await expect(
      resolveProjectCreateTarget(
        new Map([['project-host-setup-base64', Buffer.from(id).toString('base64url')]]),
        client
      )
    ).resolves.toMatchObject({ repoSelector: 'id:repo-a', repoHostId: 'local', setup: { id } })
  })

  it('uses encoded recovery to distinguish raw literal escape ids from control ids', async () => {
    const client = clientReturning([
      readySetup({ id: 'setup\\u000a', repoId: 'repo-raw' }),
      readySetup({ id: 'setup\n', repoId: 'repo-control' })
    ])
    await expect(
      resolveProjectCreateTarget(
        new Map([['project-host-setup-base64', Buffer.from('setup\n').toString('base64url')]]),
        client
      )
    ).resolves.toMatchObject({ repoSelector: 'id:repo-control' })
    await expect(
      resolveProjectCreateTarget(new Map([['project-host-setup-base64', 'invalid!']]), client)
    ).rejects.toThrow('Invalid --project-host-setup-base64')
  })

  it('keeps raw ids authoritative when another setup has the same escaped display', async () => {
    const client = clientReturning([
      readySetup({ id: 'setup\\u000a', repoId: 'repo-raw' }),
      readySetup({ id: 'setup\n', repoId: 'repo-control' })
    ])
    await expect(
      resolveProjectCreateTarget(new Map([['project-host-setup', 'setup\\u000a']]), client)
    ).resolves.toMatchObject({ repoSelector: 'id:repo-raw' })
  })
})
