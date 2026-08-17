import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listManagedSkillInstalls, writeSkillInstallReceipt } from './skill-install-provenance'

describe('managed skill install receipts', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-skill-receipts-test-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('lists bounded receipt metadata without exposing package contents', async () => {
    await writeSkillInstallReceipt(root, {
      schemaVersion: 1,
      packageId: 'package-1',
      versionId: 'version-1',
      packageDigest: 'a'.repeat(64),
      archiveSha256: 'b'.repeat(64),
      scope: 'global',
      destinationIdentity: 'global:runtime-1',
      canonicalPath: join(root, 'missing', 'example'),
      placements: [],
      providers: ['codex', 'claude'],
      installedAt: '2026-08-11T00:00:00.000Z',
      hostIdentity: 'runtime-1'
    })

    await expect(listManagedSkillInstalls(root)).resolves.toEqual([
      expect.objectContaining({
        name: 'example',
        packageId: 'package-1',
        versionId: 'version-1',
        providers: ['codex', 'claude'],
        state: 'missing'
      })
    ])
  })
})
