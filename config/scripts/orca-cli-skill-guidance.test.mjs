import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const skillPath = join(projectDir, 'skills', 'orca-cli', 'SKILL.md')

describe('orca CLI skill guidance', () => {
  it('keeps independent worktree lineage separate from Git base selection', () => {
    const skill = readFileSync(skillPath, 'utf8')

    expect(skill).toContain('`--no-parent` only controls Orca lineage')
    expect(skill).toContain('omit `--base-branch` so Orca uses the repo default base')
    expect(skill).toContain('Never base it on the current feature branch')
  })
})
