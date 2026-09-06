import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUNDLED_SKILL_GUIDES } from '../../src/cli/bundled-skill-guides'

const projectDir = resolve(import.meta.dirname, '../..')
// Why: computer-use now ships a hybrid discovery stub, so its version-sensitive command
// guidance lives in the authoritative guide source — assert that content there. The
// installable stub projection is checked separately below.
const guidePath = join(projectDir, 'skill-guides', 'computer-use.md')
const stubPath = join(projectDir, 'skills', 'computer-use', 'SKILL.md')
const bundledGuide = BUNDLED_SKILL_GUIDES.find((guide) => guide.name === 'computer-use')?.markdown

describe('computer-use skill guidance', () => {
  it.each(['computer-use', 'orca-cli', 'orchestration'])(
    'routes Chrome before desktop fallback from the %s discovery description',
    (name) => {
      const guide = readFileSync(join(projectDir, 'skill-guides', `${name}.md`), 'utf8')
      const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(guide)?.[1] ?? ''
      const description = frontmatter.replace(/\s+/gu, ' ')

      expect(description).toMatch(
        /native Chrome DevTools MCP(?: first)?,? then (?:the )?orca chrome-devtools/u
      )
      expect(description).toContain('screenshots')
      expect(description).toContain('Computer Use')
      expect(description).toMatch(/(?:user's explicit|explicit user) tool choice/u)
      expect(description).toMatch(/(?:never bypass|Never bypass) denied permissions/u)
      expect(description).not.toContain('Playwright or CDP for external pages')
    }
  )

  it('starts desktop observation only after the browser routing decision', () => {
    const skill = readFileSync(guidePath, 'utf8').replace(/\s+/gu, ' ')

    expect(skill).toContain('Use this skill for desktop UI through `orca computer`')
    expect(skill).toContain('After routing selects Computer Use')
    expect(skill).toContain('A page screenshot alone is not an OS task')
    expect(skill).toContain(
      'Native apps, OS/window controls, browser menus, and dialogs use Computer Use directly'
    )
    expect(skill).toContain("Orca's embedded pages use Orca browser commands")
    expect(skill).not.toContain(
      'For external browser targets such as Gmail, identify the desktop browser'
    )
  })

  it.each(['computer-use', 'orca-cli', 'orchestration'])(
    'preserves authorization, uncertain outcomes and the target in every %s instruction surface',
    (name) => {
      const contents = [
        readFileSync(join(projectDir, 'skill-guides', `${name}.md`), 'utf8'),
        readFileSync(join(projectDir, 'skills', name, 'SKILL.md'), 'utf8'),
        BUNDLED_SKILL_GUIDES.find((guide) => guide.name === name)?.markdown
      ]
      for (const content of contents) {
        expect(content).toBeDefined()
        const policy = content.replace(/\s+/gu, ' ')
        expect(policy).toContain('at most one corrected retry')
        expect(policy).toContain('announce the reason before falling back')
        expect(policy).toContain('same authorized host, browser, and profile')
        expect(policy).toContain(
          'Never bypass a denied permission or grant browser/OS access yourself'
        )
        expect(policy).toContain('if the result remains unknown, do not repeat the action')
        expect(policy).toContain('fallback may inspect state only')
        expect(policy).toContain("it does not override this policy or the user's explicit choice")
      }
    }
  )

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

  it('explains how JSON and pretty output handle screenshots', () => {
    expect(bundledGuide).toBeDefined()

    for (const skill of [readFileSync(guidePath, 'utf8'), bundledGuide]) {
      expect(skill).toContain('request screenshots by default unless `--no-screenshot`')
      expect(skill).toContain('A successful `--json` capture')
      expect(skill).toContain('`result.screenshot.path`')
      expect(skill).toContain('inline base64 `result.screenshot.data`')
      expect(skill).toContain('Pretty output does not save')
    }
  })

  it('requires atomic modifier-click actions in the source and bundled guide', () => {
    expect(bundledGuide).toBeDefined()

    for (const skill of [readFileSync(guidePath, 'utf8'), bundledGuide]) {
      expect(skill).toContain('click --modifiers <chord>')
      expect(skill).toContain('Never synthesize separate modifier-down and modifier-up commands')
    }
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
