import { expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { SleptMailRecord } from './mail-wake-obligation'
import { SleptPaneHost } from './slept-pane-host'

type Registration = ExecutionHostId | { executionHostId: ExecutionHostId; connectionId: string }

const hostsFor = (
  record: Pick<SleptMailRecord, 'worktreeId' | 'connectionId'>,
  partition: string | null,
  registrations: readonly Registration[]
) => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host check reads only worktreeId and connectionId.
  const records = new Map([['pane', record as SleptMailRecord]])
  const repos = registrations.map((repo) =>
    typeof repo === 'string' ? { executionHostId: repo, connectionId: null } : repo
  )
  return new SleptPaneHost({ hostOf: () => partition, records }, () => repos)
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
  const twins = ['ssh:host-b', 'ssh:host-a'] as const
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
  const unpartitioned = hostsFor({ worktreeId: 'rt::/w', connectionId: 'host-a' }, 'local', [
    { executionHostId: 'runtime:env', connectionId: 'host-a' },
    'runtime:other'
  ])
  expect(unpartitioned.on('runtime:env')('pane')).toBe(true)
  expect(unpartitioned.on('runtime:other')('pane')).toBe(false)
})

it('a runtime pane follows its repo to the rotated runtime id only when the old id lost the repo', () => {
  const record = { worktreeId: 'rt::/w', connectionId: null }
  const moved = hostsFor(record, 'runtime:old', ['runtime:new'])
  expect(moved.on('runtime:new')('pane')).toBe(true)
  expect(moved.on('runtime:other')('pane')).toBe(false)
  expect(moved.on('ssh:runtime:new')('pane')).toBe(false)
  const nested = { worktreeId: 'rt::/w', connectionId: 'host-a' }
  const viaSameTarget = hostsFor(nested, 'runtime:old', [
    { executionHostId: 'runtime:new', connectionId: 'host-a' }
  ])
  expect(viaSameTarget.on('runtime:new')('pane')).toBe(true)
  const viaOtherTarget = hostsFor(nested, 'runtime:old', [
    { executionHostId: 'runtime:new', connectionId: 'host-b' }
  ])
  expect(viaOtherTarget.on('runtime:new')('pane')).toBe(false)
  const stillOld = hostsFor(record, 'runtime:old', ['runtime:new', 'runtime:old'])
  expect(stillOld.on('runtime:new')('pane')).toBe(false)
  expect(stillOld.on('runtime:old')('pane')).toBe(true)
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
