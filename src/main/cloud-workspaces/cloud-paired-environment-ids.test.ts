// PAIRED-AWARE: a paired Orca Cloud workspace's server is Orca Cloud for every check, like this
// desktop's own sandboxes (opened elsewhere, a teammate's, a link, or started from a GitHub-only repo).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import {
  cloudPairedAccountId,
  cloudPairedEnvironmentIds,
  cloudPairedSandboxesByEnvironment,
  noteCloudPairingBindings,
  setCloudPairingActiveAccountReader
} from './cloud-paired-environment-ids'
import { isOrcaCloudRuntimeEnvironment } from '../../shared/remote-runtime/host-catalog/orca-cloud-environment-name'
import { cloudSandboxIdForEnvironment } from '../hosted-sandbox/hosted-remote-desktop'
import { bumpOrcaProfileIndexGeneration } from '../orca-profiles/profile-index-generation'

afterEach(() => {
  noteCloudPairingBindings({})
  setCloudPairingActiveAccountReader(() => null)
})

describe('paired Orca Cloud servers', () => {
  it('tracks the bindings as read or written, and says when the set changed', () => {
    expect(noteCloudPairingBindings({ sbx_a: { environmentId: 'env-a' } })).toBe(true)
    expect(noteCloudPairingBindings({ sbx_a: { environmentId: 'env-a' } })).toBe(false)
    expect([...cloudPairedSandboxesByEnvironment()]).toEqual([['env-a', 'sbx_a']])
    expect(noteCloudPairingBindings({})).toBe(true)
    expect(cloudPairedEnvironmentIds().size).toBe(0)
  })

  it('the shared Orca Cloud check accepts a paired server, whatever its saved name', () => {
    expect(isOrcaCloudRuntimeEnvironment({ name: 'my-repo (cloud)', orcaCloudPaired: true })).toBe(
      true
    )
    expect(isOrcaCloudRuntimeEnvironment({ name: 'my-repo (cloud)' })).toBe(false)
    expect(isOrcaCloudRuntimeEnvironment({ name: 'build box', source: 'manual' })).toBe(false)
    // This desktop's own sandboxes are still recognised as before.
    expect(
      isOrcaCloudRuntimeEnvironment({ name: 'repo sandbox 22b5b1e7', source: 'ephemeral-vm' })
    ).toBe(true)
  })

  it('a paired server resolves to its sandbox (Remote Desktop, delete preflight)', () => {
    noteCloudPairingBindings({ sbx_paired: { environmentId: 'env-paired' } })
    const userData = mkdtempSync(join(tmpdir(), 'orca-paired-'))
    expect(cloudSandboxIdForEnvironment(userData, 'env-paired')).toBe('sbx_paired')
    expect(cloudSandboxIdForEnvironment(userData, 'env-other')).toBeNull()
  })
})

describe('paired servers by account (PAIRED-ACCOUNT-FILTER)', () => {
  const bindings = {
    sbx_mine: { environmentId: 'env-mine', accountId: 'org:team-one' },
    sbx_theirs: { environmentId: 'env-theirs', accountId: 'org:team-two' },
    sbx_old: { environmentId: 'env-old' }
  }

  it("only the active account's pairings (and unstamped ones) resolve to a sandbox", () => {
    let active = 'org:team-one'
    setCloudPairingActiveAccountReader(() => active)
    noteCloudPairingBindings(bindings)
    expect([...cloudPairedSandboxesByEnvironment()].sort()).toEqual([
      ['env-mine', 'sbx_mine'],
      ['env-old', 'sbx_old']
    ])
    // A team switch (a profile-index write) flips it at once: no stale binding resolves.
    active = 'org:team-two'
    bumpOrcaProfileIndexGeneration()
    expect([...cloudPairedSandboxesByEnvironment()].sort()).toEqual([
      ['env-old', 'sbx_old'],
      ['env-theirs', 'sbx_theirs']
    ])
    const userData = mkdtempSync(join(tmpdir(), 'orca-paired-'))
    expect(cloudSandboxIdForEnvironment(userData, 'env-mine')).toBeNull()
  })

  it('the catalog still marks every paired server, with the account it was made under', () => {
    setCloudPairingActiveAccountReader(() => 'org:team-one')
    noteCloudPairingBindings(bindings)
    expect([...cloudPairedEnvironmentIds()].sort()).toEqual(['env-mine', 'env-old', 'env-theirs'])
    expect(cloudPairedAccountId('env-theirs')).toBe('org:team-two')
    expect(cloudPairedAccountId('env-old')).toBeNull()
  })

  it('reads the account once per profile-index write, never on every lookup (no disk per poll)', () => {
    const read = vi.fn(() => 'org:team-one')
    setCloudPairingActiveAccountReader(read)
    noteCloudPairingBindings(bindings)
    for (let i = 0; i < 5; i += 1) {
      cloudPairedSandboxesByEnvironment()
    }
    expect(read).toHaveBeenCalledTimes(1)
    bumpOrcaProfileIndexGeneration()
    cloudPairedSandboxesByEnvironment()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('a re-stamped binding counts as a change (the catalog republishes)', () => {
    noteCloudPairingBindings({ sbx_old: { environmentId: 'env-old' } })
    expect(
      noteCloudPairingBindings({ sbx_old: { environmentId: 'env-old', accountId: 'org:team-one' } })
    ).toBe(true)
  })
})
