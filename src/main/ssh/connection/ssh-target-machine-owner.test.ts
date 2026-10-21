import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { hostKeyPolicyForOwner } from '../ssh-host-key-decision'
import {
  previousGetLegacyManagedOrcadOwnerEnvironmentId,
  previousIsEphemeralRuntimeSshOwner,
  previousIsRuntimeOwnedSshTarget,
  previousManagedOrcadServerName
} from './ssh-target-owner.previous-release.test-fixture'

// A machine-owned target exactly as this build persists it.
const PERSISTED = `{
  "id": "machine-0123456789abcdef0123",
  "label": "omarchy-dev",
  "host": "omarchy",
  "port": 42200,
  "username": "dev",
  "configHost": "omarchy",
  "source": "manual",
  "generation": 7,
  "owner": {
    "type": "machine",
    "runtimeId": "machine-0123456789abcdef0123",
    "providerKey": "plugin:acme.omarchy/omarchy",
    "machineId": "sbx-1",
    "hostKeys": ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"]
  }
}`

// What the previous release's loader assumed without checking: owner.runtimeId is a string.
const previousReleaseRow = z
  .object({
    label: z.string(),
    owner: z.object({ type: z.string(), runtimeId: z.string() }).passthrough()
  })
  .passthrough()

describe('a machine-owned target loaded by the previous release', () => {
  const row = previousReleaseRow.parse(JSON.parse(PERSISTED))

  it('stays hidden and is pinned normally rather than trusted as an ephemeral VM', () => {
    expect(previousIsRuntimeOwnedSshTarget(row)).toBe(true)
    expect(previousIsEphemeralRuntimeSshOwner(row.owner)).toBe(false)
    expect(previousGetLegacyManagedOrcadOwnerEnvironmentId(row.owner)).toBeNull()
    expect(previousManagedOrcadServerName(row)).toBe('omarchy-dev')
  })

  it('is provider-pinned by this build', () => {
    const current = z
      .object({
        owner: z.object({
          type: z.literal('machine'),
          runtimeId: z.string(),
          providerKey: z.string(),
          machineId: z.string(),
          hostKeys: z.array(z.string())
        })
      })
      .parse(JSON.parse(PERSISTED))
    expect(hostKeyPolicyForOwner(current.owner).kind).toBe('provider-pinned')
  })
})
