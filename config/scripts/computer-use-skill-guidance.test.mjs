import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const skillPath = join(projectDir, 'skills', 'computer-use', 'SKILL.md')

describe('computer-use skill guidance', () => {
  it('keeps web-app targeting on the computer-use surface', () => {
    const skill = readFileSync(skillPath, 'utf8')

    expect(skill).toContain('Use this skill for desktop UI through `orca computer`')
    expect(skill).toContain('operate the desktop browser app/window that contains the page')
    expect(skill).not.toContain('orca goto')
    expect(skill).not.toContain('orca snapshot')
    expect(skill).not.toContain('orca click')
    expect(skill).not.toContain('orca fill')
    expect(skill).not.toContain('Routing:')
  })

  it('warns agents to verify browser-hosted form focus before drafting text', () => {
    const skill = readFileSync(skillPath, 'utf8')

    expect(skill).toContain('For browser-hosted forms such as Gmail compose')
    expect(skill).toContain('verify the focused UI element after each field action')
    expect(skill).toContain('Prefer `paste-text` into the verified focused field')
  })

  it('warns agents about occluded Linux and Windows screenshots', () => {
    const skill = readFileSync(skillPath, 'utf8')

    expect(skill).toContain('On Linux and Windows')
    expect(skill).toContain('use `--restore-window` so another window does not cover')
    expect(skill).toContain('trust the tree over potentially occluded pixels')
  })
})
