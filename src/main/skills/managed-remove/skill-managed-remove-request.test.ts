import {
  createSkillManagementHome,
  removeSkillManagementHomes
} from '../install/testing/skill-management-home'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeSharedSkillInstall } from './skill-managed-remove-request'

describe('managed skill removal request', () => {
  let homeDirectory = ''
  let dependencies: Awaited<ReturnType<typeof createSkillManagementHome>>['dependencies']
  beforeEach(async () => {
    const fixture = await createSkillManagementHome()
    homeDirectory = fixture.homeDirectory
    dependencies = fixture.dependencies
  })
  afterEach(removeSkillManagementHomes)

  it('refuses to remove an unowned destination', async () => {
    const canonicalPath = join(homeDirectory, '.agents', 'skills', 'example')
    await mkdir(canonicalPath, { recursive: true })

    const result = await removeSharedSkillInstall(
      {
        operationId: 'operation-1',
        name: 'example',
        destination: { scope: 'global' }
      },
      dependencies()
    )

    expect(result).toMatchObject({ status: 'conflict', conflict: { kind: 'unowned' } })
  })
})
