import { describe, expect, it } from 'vitest'
import {
  skillCloudBundlePackageVersionInstallSchema,
  skillCloudBundleShareInstallSchema,
  skillCloudPackageVersionInstallSchema,
  skillCloudShareInstallSchema
} from './skill-cloud-install-ipc-schemas'

const destination = { scope: 'global' as const }
const providers = ['codex', 'claude']

describe('skill cloud install IPC schemas', () => {
  it('accepts provider selection for every install entry point', () => {
    expect(
      skillCloudShareInstallSchema.parse({
        shareId: 'share-1',
        versionId: 'version-1',
        destination,
        providers
      })
    ).toMatchObject({ providers })
    expect(
      skillCloudBundleShareInstallSchema.parse({
        shareId: 'share-1',
        versionId: 'version-1',
        selectedSkillIds: ['skill-1'],
        destination,
        providers
      })
    ).toMatchObject({ providers })
    expect(
      skillCloudPackageVersionInstallSchema.parse({
        packageId: 'package-1',
        versionId: 'version-1',
        destination,
        providers
      })
    ).toMatchObject({ providers })
    expect(
      skillCloudBundlePackageVersionInstallSchema.parse({
        packageId: 'package-1',
        versionId: 'version-1',
        selectedSkillIds: ['skill-1'],
        destination,
        providers
      })
    ).toMatchObject({ providers })
  })

  it('bounds provider selection', () => {
    expect(() =>
      skillCloudBundleShareInstallSchema.parse({
        shareId: 'share-1',
        versionId: 'version-1',
        selectedSkillIds: ['skill-1'],
        destination,
        providers: Array.from({ length: 65 }, (_, index) => `provider-${index}`)
      })
    ).toThrow()
  })

  it('requires the reviewed version for share-link installs', () => {
    expect(() => skillCloudShareInstallSchema.parse({ shareId: 'share-1', destination })).toThrow()
    expect(() =>
      skillCloudBundleShareInstallSchema.parse({
        shareId: 'share-1',
        selectedSkillIds: ['skill-1'],
        destination
      })
    ).toThrow()
  })
})
