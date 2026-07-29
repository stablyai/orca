import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(import.meta.dirname, '../..')
// Why: computer-use now ships a hybrid discovery stub, so its version-sensitive command
// guidance lives in the authoritative guide source — assert that content there. The
// installable stub projection is checked separately below.
const guidePath = join(projectDir, 'skill-guides', 'computer-use.md')
const stubPath = join(projectDir, 'skills', 'computer-use', 'SKILL.md')

describe('computer-use skill guidance', () => {
  it('keeps web-app targeting on the computer-use surface', () => {
    const skill = readFileSync(guidePath, 'utf8')

    expect(skill).toContain('Use this skill for desktop UI through `orca computer`')
    expect(skill).toContain('operate the desktop browser app/window that contains the page')
    expect(skill).not.toContain('orca goto')
    expect(skill).not.toContain('orca snapshot')
    expect(skill).not.toContain('orca click')
    expect(skill).not.toContain('orca fill')
    expect(skill).not.toContain('Routing:')
  })

  it('warns agents to verify browser-hosted form focus before drafting text', () => {
    const skill = readFileSync(guidePath, 'utf8')

    expect(skill).toContain('For browser-hosted forms such as Gmail compose')
    expect(skill).toContain('verify the focused UI element after each field action')
    expect(skill).toContain('Prefer `paste-text` into the verified focused field')
  })

  it('warns agents about occluded Linux and Windows screenshots', () => {
    const skill = readFileSync(guidePath, 'utf8')

    expect(skill).toContain('On Linux and Windows')
    expect(skill).toContain('use `--restore-window` so another window does not cover')
    expect(skill).toContain('trust the tree over potentially occluded pixels')
  })

  it('points JSON users to the public accessibility-tree field', () => {
    const skill = readFileSync(guidePath, 'utf8')

    expect(skill).toContain('`result.snapshot.treeText`')
    expect(skill).not.toContain('`result.elements`')
  })
})

describe('computer-use install stub', () => {
  it('points at the version-matched guide and preserves the safe resolver', () => {
    const stub = readFileSync(stubPath, 'utf8')

    expect(stub).toContain('discovery stub')
    expect(stub).toContain('ORCA skills get computer-use')
    // The safe CLI-resolution contract must survive in the stub, never a bare `orca`.
    expect(stub).toContain('ORCA_CLI_COMMAND')
    expect(stub).toContain('orca-dev')
    expect(stub).toContain('orca-ide')
    expect(stub).toContain('GNOME Orca screen reader')
    expect(stub).not.toMatch(/^orca /mu)
  })

  it('gives older binaries a bounded fallback instead of a dead end', () => {
    const stub = readFileSync(stubPath, 'utf8').replace(/\s+/gu, ' ')

    expect(stub).toContain('explicitly reports that `skills get` is an unknown command')
    expect(stub).toContain('do not invent commands')
    expect(stub).toContain('ask the user rather than guessing')
  })

  it('drops the changing command reference from the installable file', () => {
    const stub = readFileSync(stubPath, 'utf8')
    const guide = readFileSync(guidePath, 'utf8')

    // Version-sensitive command detail lives in the binary-served guide now, not here.
    expect(stub).not.toContain('result.snapshot.treeText')
    expect(stub).not.toContain('--restore-window')
    expect(stub.length).toBeLessThan(guide.length)
  })

  it('keeps the routing frontmatter identical to the guide', () => {
    const frontmatter = (text) => /^---\n[\s\S]*?\n---\n/u.exec(text)[0]

    expect(frontmatter(readFileSync(stubPath, 'utf8'))).toBe(
      frontmatter(readFileSync(guidePath, 'utf8'))
    )
  })
})
