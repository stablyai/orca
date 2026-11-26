import { expect, it } from 'vitest'
import type { SleptMailRecord } from './mail-wake-obligation'
import { SleptPaneHost } from './slept-pane-host'

const hostsFor = (
  record: Pick<SleptMailRecord, 'worktreeId' | 'connectionId'>,
  partition: string | null,
  registrations: readonly string[]
) => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host check reads only worktreeId and connectionId.
  const records = new Map([['pane', record as SleptMailRecord]])
  return new SleptPaneHost({ hostOf: () => partition, records }, () => new Set(registrations))
}

it('matches a slept pane to its host however the saved host id is spelled', () => {
  const hosts = hostsFor({ worktreeId: 'repo-wsl::/home/u/w', connectionId: null }, null, [
    'runtime:wsl:Ubuntu'
  ])
  expect(hosts.on('runtime:wsl%3AUbuntu')('pane')).toBe(true)
  expect(hosts.on('runtime:wsl:Ubuntu')('pane')).toBe(true)
  expect(hosts.on('runtime:other')('pane')).toBe(false)
  expect(hosts.on('local')('pane')).toBe(false)
})

it('a pane whose partition or saved connection names host A is not on its twin repo host B', () => {
  const twins = ['ssh:host-b', 'ssh:host-a']
  const byPartition = hostsFor({ worktreeId: 'twin::/w', connectionId: null }, 'ssh:host-a', twins)
  const byConnection = hostsFor({ worktreeId: 'twin::/w', connectionId: 'host-a' }, 'local', twins)
  const folder = hostsFor({ worktreeId: 'folder:f', connectionId: null }, 'ssh:host-a', [])
  for (const hosts of [byPartition, byConnection, folder]) {
    expect(hosts.on('ssh:host-b')('pane')).toBe(false)
    expect(hosts.on('runtime:env-b')('pane')).toBe(false)
    expect(hosts.on('ssh:host-a')('pane')).toBe(true)
  }
  expect(byConnection.on('local')('pane')).toBe(false)
  const nested = hostsFor({ worktreeId: 'twin::/w', connectionId: 'host-a' }, 'runtime:env', twins)
  expect(nested.on('runtime:env')('pane')).toBe(true)
  expect(nested.on('ssh:host-a')('pane')).toBe(true)
  expect(nested.on('ssh:host-b')('pane')).toBe(false)
})

it('a pane with no known owner counts as on every host', () => {
  const unknown = hostsFor({ worktreeId: 'folder:f', connectionId: null }, 'local', [])
  expect(unknown.on('ssh:host-b')('pane')).toBe(true)
  expect(unknown.on('runtime:env')('pane')).toBe(true)
  const unresolved = hostsFor({ worktreeId: 'twin::/w', connectionId: null }, null, [
    'runtime:unresolved-owner'
  ])
  expect(unresolved.on('ssh:host-b')('pane')).toBe(true)
})
