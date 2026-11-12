// PAIRED-AWARE: a paired Orca Cloud workspace's server is Orca Cloud for every check, like this
// desktop's own sandboxes (opened elsewhere, a teammate's, a link, or started from a GitHub-only repo).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import {
  cloudPairedEnvironmentIds,
  cloudPairedSandboxesByEnvironment,
  noteCloudPairingBindings
} from './cloud-paired-environment-ids'
import { isOrcaCloudRuntimeEnvironment } from '../../shared/remote-runtime/host-catalog/orca-cloud-environment-name'
import { cloudSandboxIdForEnvironment } from '../hosted-sandbox/hosted-remote-desktop'

afterEach(() => {
  noteCloudPairingBindings({})
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
