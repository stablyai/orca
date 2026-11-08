import {
  createSkillManagementHome,
  removeSkillManagementHomes
} from './testing/skill-management-home'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { previewSharedSkillInstall } from './skill-install-preview'

describe('skill install management', () => {
  let dependencies: Awaited<ReturnType<typeof createSkillManagementHome>>['dependencies']
  beforeEach(async () => {
    const fixture = await createSkillManagementHome()
    dependencies = fixture.dependencies
  })
  afterEach(removeSkillManagementHomes)

  it('previews a missing global install without mutating the destination', async () => {
    const preview = await previewSharedSkillInstall(
      {
        name: 'example',
        package: {
          packageId: 'package-1',
          versionId: 'version-1',
          packageDigest: 'a'.repeat(64),
          archiveSha256: 'b'.repeat(64),
          compressedBytes: 100
        },
        destination: { scope: 'global' }
      },
      dependencies()
    )

    expect(preview).toMatchObject({
      name: 'example',
      currentState: 'missing',
      destinationIdentity: 'global:runtime-1'
    })
    expect(preview.providers.map((provider) => provider.provider)).toEqual(['codex', 'claude'])
  })
})
