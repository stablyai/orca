import { mkdir, readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nativeBundledSkillFilesystem } from './filesystem'
import { resolveBundledSkillTargets } from './targets'
import {
  linkDirectory,
  makeSkillHome,
  NAME,
  NEW_TEXT,
  previewAndInstall,
  removeSkillHomes,
  serviceInput,
  snapshot,
  writeCopy
} from './skill-home.test-support'

const EDITED_TEXT = `---\nname: ${NAME}\n---\nmine\n`

afterEach(removeSkillHomes)

describe('workspace bundled skill targets', () => {
  it.skipIf(process.platform === 'win32')(
    'keeps byte-distinct POSIX workspace names separate',
    async () => {
      const home = await makeSkillHome()
      const workspace = join(home.root, 'caf\u00e9')
      const root = join(workspace, '.claude', 'skills')
      const filesystem = {
        ...nativeBundledSkillFilesystem,
        realpath: async (path: string) => {
          if (path === workspace) {
            return workspace
          }
          return path === root ? join(home.root, 'cafe\u0301', 'skills') : null
        }
      }

      const roots = await resolveBundledSkillTargets(
        serviceInput(home, { workspaceDirectory: workspace }),
        filesystem
      )

      expect(roots.map((target) => target.path)).toEqual([join(workspace, '.agents', 'skills')])
    }
  )

  it.each([
    ['.claude', false],
    ['.claude', true],
    ['.agents', false],
    ['.agents', true]
  ] as const)(
    'ignores an escaping workspace %s root (existing copy: %s)',
    async (agent, exists) => {
      const home = await makeSkillHome()
      const project = join(home.home, 'src', 'project')
      const outside = join(home.home, agent, 'skills')
      const linkedRoot = join(project, agent, 'skills')
      await mkdir(outside, { recursive: true })
      await mkdir(dirname(linkedRoot), { recursive: true })
      if (exists) {
        await writeCopy(join(outside, NAME), EDITED_TEXT)
      }
      const before = await snapshot(join(outside, NAME))
      const entries = await readdir(outside)
      await linkDirectory(
        process.platform === 'win32' ? outside : relative(dirname(linkedRoot), outside),
        linkedRoot
      )

      const { plan } = await previewAndInstall(
        serviceInput(home, { workspaceDirectory: project, force: [join(linkedRoot, NAME)] })
      )

      expect(await readdir(outside)).toEqual(entries)
      expect(await snapshot(join(outside, NAME))).toBe(before)
      expect(plan.skills[0].ops.some((op) => op.path === join(linkedRoot, NAME))).toBe(false)
    }
  )

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
