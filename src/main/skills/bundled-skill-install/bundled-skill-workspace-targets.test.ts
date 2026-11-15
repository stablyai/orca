import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  linkDirectory,
  makeSkillHome,
  NAME,
  NEW_TEXT,
  previewAndInstall,
  removeSkillHomes,
  serviceInput,
  snapshot
} from './testing/bundled-skill-home'

afterEach(removeSkillHomes)

describe('workspace bundled skill targets', () => {
  it('accepts an internal root through a symlinked workspace', async () => {
    const home = await makeSkillHome()
    const project = join(home.root, 'project')
    const workspace = join(home.root, 'workspace-link')
    const internal = join(project, 'internal-skills')
    await mkdir(internal, { recursive: true })
    await mkdir(join(project, '.claude'))
    await linkDirectory(internal, join(project, '.claude', 'skills'))
    await linkDirectory(project, workspace)

    const { plan } = await previewAndInstall(serviceInput(home, { workspaceDirectory: workspace }))

    expect(plan.skills[0].ops.map((op) => op.kind)).toEqual(['write', 'link'])
    expect(await readFile(join(internal, NAME, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
    expect(await snapshot(home.claude)).toBe('missing')
  })

  it('installs into a safe agent root when the shared root escapes', async () => {
    const home = await makeSkillHome()
    const project = join(home.root, 'project')
    await mkdir(dirname(home.shared), { recursive: true })
    await mkdir(join(project, '.agents'), { recursive: true })
    await mkdir(join(project, '.claude', 'skills'), { recursive: true })
    await linkDirectory(dirname(home.shared), join(project, '.agents', 'skills'))

    const { plan } = await previewAndInstall(serviceInput(home, { workspaceDirectory: project }))

    expect(plan.skills[0].ops.map((op) => [op.path, op.kind])).toEqual([
      [join(project, '.claude', 'skills', NAME), 'write']
    ])
    expect(await snapshot(join(project, '.claude', 'skills', NAME))).toContain(NEW_TEXT)
    expect(await snapshot(home.shared)).toBe('missing')
  })
})
