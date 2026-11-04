import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUNDLED_SKILL_SOURCES } from './bundled-skill-install/bundled-skill-sources'
import { autoUpdateInstalledBundledSkills } from './bundled-skill-install/service'
import { nativeBundledSkillFilesystem } from './bundled-skill-install/filesystem'
import {
  linkDirectory,
  makeSkillHome,
  removeSkillHomes,
  serviceInput,
  writeCopy
} from './bundled-skill-install/skill-home.test-support'
import { clearSkillRootScanCache, discoverSkills } from './discovery'
import { parseWslSkillDiscoveryOutput } from './skill-discovery-wsl-observation'
import { buildSkillDiscoverySources } from './skill-discovery-sources'

const NAME = 'orca-computer-use'
const OLD = 'computer-use'
const FIXTURE = join(
  import.meta.dirname,
  'bundled-skill-install',
  'computer-use-before-rename.skill-md.txt'
)
afterEach(async () => {
  clearSkillRootScanCache()
  await removeSkillHomes()
})

describe('released computer-use installation migration', () => {
  it.each([true, false])(
    'discovers one canonical skill before and after migration, links: %s',
    async (supportsLinks) => {
      const home = await makeSkillHome()
      const old = join(dirname(home.shared), OLD)
      const oldClaude = join(dirname(home.claude), OLD)
      const shared = join(dirname(home.shared), NAME)
      const claude = join(dirname(home.claude), NAME)
      const markdown = await readFile(FIXTURE, 'utf8')
      await writeCopy(old, markdown)
      await mkdir(dirname(oldClaude), { recursive: true })
      await (supportsLinks ? linkDirectory(old, oldClaude) : writeCopy(oldClaude, markdown))
      const discover = () =>
        discoverSkills({
          homeDir: home.home,
          includeCwd: false,
          sourceKinds: ['home'],
          names: [NAME],
          refresh: true
        })
      const before = await discover()
      expect(before.skills).toHaveLength(supportsLinks ? 1 : 2)
      expect(before.skills.every((skill) => skill.bundledName === NAME)).toBe(true)

      await autoUpdateInstalledBundledSkills({
        ...serviceInput(home, {
          installedOnly: true,
          filesystem: { ...nativeBundledSkillFilesystem, supportsLinks }
        }),
        sources: BUNDLED_SKILL_SOURCES,
        names: [OLD]
      })

      const source = BUNDLED_SKILL_SOURCES.find((skill) => skill.name === NAME)
      expect(await readFile(join(shared, 'SKILL.md'), 'utf8')).toBe(source?.text)
      expect(await readFile(join(claude, 'SKILL.md'), 'utf8')).toBe(source?.text)
      const discovered = await discover()
      expect(discovered.skills).toHaveLength(supportsLinks ? 1 : 2)
      expect(discovered.skills.every((skill) => skill.name === NAME)).toBe(true)
      expect(discovered.skills.some((skill) => skill.directoryPath === old)).toBe(false)
      const olderClient = await discoverSkills({
        homeDir: home.home,
        includeCwd: false,
        sourceKinds: ['home'],
        names: [OLD],
        refresh: true
      })
      expect(olderClient.skills.filter((skill) => skill.name === OLD)).toHaveLength(
        supportsLinks ? 1 : 2
      )
    }
  )

  it('never recognizes another provider’s generic name as Orca Computer Use', async () => {
    const home = await makeSkillHome()
    await writeCopy(
      join(dirname(home.shared), OLD),
      '---\nname: computer-use\ndescription: Another provider\n---\nDifferent tool\n'
    )
    const result = await discoverSkills({
      homeDir: home.home,
      includeCwd: false,
      names: [NAME],
      sourceKinds: ['home'],
      refresh: true
    })
    expect(result.skills.some((skill) => skill.name === NAME)).toBe(false)
  })

  it('keeps a former package with user-added files visible alongside the new skill', async () => {
    const home = await makeSkillHome()
    const old = join(dirname(home.shared), OLD)
    await writeCopy(old, await readFile(FIXTURE, 'utf8'), { 'notes.md': 'My workflow' })
    const source = BUNDLED_SKILL_SOURCES.find((skill) => skill.name === NAME)
    if (!source) {
      throw new Error('Canonical skill is missing')
    }
    await writeCopy(join(dirname(home.shared), NAME), source.text)
    const result = await discoverSkills({
      homeDir: home.home,
      includeCwd: false,
      sourceKinds: ['home'],
      refresh: true
    })
    expect(result.skills.map((skill) => skill.name).sort()).toEqual([OLD, NAME])
    expect(await readFile(join(old, 'notes.md'), 'utf8')).toBe('My workflow')
  })

  it('recognizes the shipped former skill through WSL discovery without claiming unrelated names', async () => {
    const home = await makeSkillHome()
    const roots = buildSkillDiscoverySources({ homeDir: home.home, repos: [], includeCwd: false })
    const root = roots[0]
    const markdown = await readFile(FIXTURE, 'utf8')
    const row = (name: string, body: string) =>
      [
        'S',
        '0',
        `${root.path}/${name}/SKILL.md`,
        `${root.path}/${name}/SKILL.md`,
        '1',
        Buffer.from(body).toString('base64')
      ].join('\0')
    const output = `R\x000\x001\0${row(OLD, markdown)}\0${row('other', '---\nname: computer-use\n---\nOther tool\n')}\0`
    const result = parseWslSkillDiscoveryOutput(output, roots, 42, ['home'], [NAME])
    expect(result.skills.filter((skill) => skill.bundledName === NAME)).toHaveLength(1)
  })
})
