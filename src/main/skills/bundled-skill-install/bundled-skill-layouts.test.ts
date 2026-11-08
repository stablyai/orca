import { mkdir, readFile, readlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import '../transaction-state/skill-install-provenance'
import '../install/skill-install-recovery'
import { installBundledSkills, previewBundledSkillInstall } from './bundled-skill-installation'
import {
  linkDirectory,
  makeSkillHome,
  NAME,
  NEW_TEXT,
  OLD_TEXT,
  opsOf,
  previewAndInstall,
  removeSkillHomes,
  serviceInput,
  snapshot,
  writeCopy,
  writeNpxLock,
  type SkillHome
} from './testing/bundled-skill-home'

const EDITED_TEXT = `---\nname: ${NAME}\n---\nmine\n`

async function linkClaudeToShared(home: SkillHome) {
  await mkdir(dirname(home.claude), { recursive: true })
  await linkDirectory(home.shared, home.claude)
}

async function npxShared(home: SkillHome, text = OLD_TEXT, extra: Record<string, string> = {}) {
  await writeNpxLock(home)
  await writeCopy(home.shared, text, extra)
  await linkClaudeToShared(home)
}

afterEach(async () => {
  await removeSkillHomes()
})

describe('bundled skill install edges', () => {
  it('keeps the replaced copy in a backup beside the skills root', async () => {
    const home = await makeSkillHome()
    await npxShared(home, EDITED_TEXT)
    const { result } = await previewAndInstall(serviceInput(home, { force: [home.shared] }))
    const backup = result.skills[0].ops[0].backupPath ?? ''
    expect(backup.startsWith(join(home.home, '.agents', '.orca-skill-backups', `${NAME}-`))).toBe(
      true
    )
    expect(await readFile(join(backup, 'SKILL.md'), 'utf8')).toBe(EDITED_TEXT)
  })

  it('keeps a project Replace backup in the home, not the repo', async () => {
    const home = await makeSkillHome()
    const project = join(home.root, 'project')
    const projectShared = join(project, '.agents', 'skills', NAME)
    await writeCopy(projectShared, EDITED_TEXT)
    const input = serviceInput(home, { workspaceDirectory: project, force: [projectShared] })
    const { result } = await previewAndInstall(input)
    const backup = result.skills[0].ops[0].backupPath ?? ''
    expect(backup.startsWith(join(home.home, '.agents', '.orca-skill-backups', `${NAME}-`))).toBe(
      true
    )
    expect(await readFile(join(backup, 'SKILL.md'), 'utf8')).toBe(EDITED_TEXT)
    expect(await snapshot(join(project, '.agents', '.orca-skill-backups'))).toBe('missing')
  })

  it('updates a Claude profile folder through its link to ~/.claude/skills', async () => {
    const home = await makeSkillHome()
    await writeCopy(home.claude, OLD_TEXT)
    const profileSkills = join(home.root, 'profile', 'skills')
    await mkdir(dirname(profileSkills), { recursive: true })
    await linkDirectory(dirname(home.claude), profileSkills)
    const viaProfile = serviceInput(home, { providerRootOverrides: { claude: profileSkills } })
    const viaHome = serviceInput(home)
    const previewViaHome = await previewBundledSkillInstall(viaHome)

    const { plan } = await previewAndInstall(viaProfile)
    expect(opsOf(plan)[1]).toEqual([join(profileSkills, NAME), 'update', undefined])
    expect(await readFile(join(home.claude, 'SKILL.md'), 'utf8')).toBe(NEW_TEXT)
    expect(await readlink(profileSkills)).toBe(dirname(home.claude))

    const stale = await installBundledSkills(viaHome, previewViaHome.planDigest)
    expect(stale.skills).toEqual([{ name: NAME, status: 'changed', ops: [] }])
  })
})
