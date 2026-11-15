import { mkdir, mkdtempDisposable, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { findSkillFiles } from './skill-root-file-walk'

it('keeps hidden and nested skill roots out of the scan when requested', async () => {
  await using root = await mkdtempDisposable(join(tmpdir(), 'orca-skill-walk-'))
  const visible = join(root.path, 'visible', 'SKILL.md')
  const hidden = join(root.path, '.hidden', 'skill', 'SKILL.md')
  const nested = join(root.path, 'visible', 'refs', 'skill', 'SKILL.md')
  for (const file of [visible, hidden, nested]) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, '# Skill\n')
  }

  await expect(
    findSkillFiles(root.path, 4, undefined, {
      skipHiddenDirectories: true,
      stopAtSkillDirectories: true
    })
  ).resolves.toEqual([visible])
})
