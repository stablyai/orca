import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUNDLED_SKILL_GUIDES } from '../../src/cli/bundled-skill-guides'
import {
  CANONICAL_GUIDE_NAMES,
  GUIDE_ALIASES,
  assertAliasContract,
  buildArtifacts,
  normalizeMarkdown,
  parseFrontmatter,
  verifyArtifacts,
  writeArtifacts
} from './generate-bundled-skill-guides.mjs'

const projectDir = path.resolve(import.meta.dirname, '..', '..')
const temporaryDirectories = []

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-bundled-skill-guides-'))
  temporaryDirectories.push(root)
  await Promise.all([
    cp(path.join(projectDir, 'skill-guides'), path.join(root, 'skill-guides'), {
      recursive: true
    }),
    cp(path.join(projectDir, 'skills'), path.join(root, 'skills'), { recursive: true }),
    mkdir(path.join(root, 'src', 'cli'), { recursive: true })
  ])
  return root
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('bundled skill guide generator', () => {
  it('keeps every first-phase fat projection byte-identical to its authoritative source', async () => {
    for (const name of CANONICAL_GUIDE_NAMES) {
      const source = await readFile(path.join(projectDir, 'skill-guides', `${name}.md`))
      const projection = await readFile(path.join(projectDir, 'skills', name, 'SKILL.md'))
      expect(projection, name).toEqual(source)
    }
  })

  it('embeds canonical names, discovery descriptions, Markdown, and append-only aliases', async () => {
    expect(BUNDLED_SKILL_GUIDES.map((guide) => guide.name)).toEqual(
      [...CANONICAL_GUIDE_NAMES].sort((left, right) => left.localeCompare(right, 'en'))
    )

    for (const guide of BUNDLED_SKILL_GUIDES) {
      const source = await readFile(
        path.join(projectDir, 'skill-guides', `${guide.name}.md`),
        'utf8'
      )
      const frontmatter = parseFrontmatter(source, `${guide.name}.md`)
      expect(guide.description).toBe(frontmatter.description)
      expect(guide.markdown).toBe(source)
      expect(guide.fullMarkdown).toBe(source)
      expect(guide.aliases).toEqual(GUIDE_ALIASES[guide.name])
    }
  })

  it('keeps CLI guide examples safe across shells and Linux command names', async () => {
    for (const name of ['orca-cli', 'computer-use', 'orca-emulator', 'orca-emulator-android']) {
      const source = await readFile(path.join(projectDir, 'skill-guides', `${name}.md`), 'utf8')

      expect(source).toContain('ORCA_CLI_COMMAND')
      expect(source).toContain('orca-dev')
      expect(source).toContain('orca-ide')
      expect(source).toContain('PowerShell')
      expect(source).toContain('cmd.exe')
      expect(source).toMatch(/^ORCA .+--json$/mu)
      // Why: bare command lines can launch GNOME Orca, while shell variables make
      // the same guide unusable from PowerShell and cmd.exe.
      expect(source).not.toMatch(/^orca /mu)
      expect(source).not.toMatch(/\$ORCA(?:_|\b)/u)
    }
  })

  it('builds deterministic artifacts and verifies the checked-in outputs', async () => {
    const first = await buildArtifacts(projectDir)
    const second = await buildArtifacts(projectDir)

    expect(second).toEqual(first)
    await expect(verifyArtifacts(first, projectDir)).resolves.toBeUndefined()
  })

  it('generates platform-identical output from CRLF guide sources', async () => {
    const expected = await buildArtifacts(projectDir)
    const root = await createFixture()
    for (const name of CANONICAL_GUIDE_NAMES) {
      const sourcePath = path.join(root, 'skill-guides', `${name}.md`)
      const source = await readFile(sourcePath, 'utf8')
      await writeFile(sourcePath, source.replaceAll('\n', '\r\n'))
    }

    const actual = await buildArtifacts(root)
    expect(actual.map((artifact) => artifact.content)).toEqual(
      expected.map((artifact) => artifact.content)
    )
  })

  it('pins guide sources, projections, and embedded output to LF in Git', async () => {
    const attributes = await readFile(path.join(projectDir, '.gitattributes'), 'utf8')
    expect(normalizeMarkdown(attributes)).toContain('/skill-guides/*.md text eol=lf\n')
    expect(normalizeMarkdown(attributes)).toContain('/skills/*/SKILL.md text eol=lf\n')
    expect(normalizeMarkdown(attributes)).toContain(
      '/src/cli/bundled-skill-guides.ts text eol=lf\n'
    )
  })

  it('reports stale outputs and write mode repairs all projections', async () => {
    const root = await createFixture()
    const artifacts = await buildArtifacts(root)

    await expect(verifyArtifacts(artifacts, root)).rejects.toThrow(
      'src/cli/bundled-skill-guides.ts'
    )
    await writeArtifacts(artifacts)
    await expect(verifyArtifacts(artifacts, root)).resolves.toBeUndefined()

    await writeFile(path.join(root, 'skills', 'computer-use', 'SKILL.md'), 'stale\n')
    await expect(verifyArtifacts(artifacts, root)).rejects.toThrow('skills/computer-use/SKILL.md')
  })

  it('rejects mismatched source names and ambiguous aliases', async () => {
    const root = await createFixture()
    await writeFile(
      path.join(root, 'skill-guides', 'computer-use.md'),
      '---\nname: wrong\ndescription: present\n---\n'
    )
    await expect(buildArtifacts(root)).rejects.toThrow('declares mismatched name wrong')

    expect(() =>
      assertAliasContract([
        { name: 'first', aliases: ['legacy'] },
        { name: 'second', aliases: ['legacy'] }
      ])
    ).toThrow('assigned more than once')
    expect(() =>
      assertAliasContract([
        { name: 'first', aliases: ['second'] },
        { name: 'second', aliases: [] }
      ])
    ).toThrow('collides with canonical name')
  })
})
