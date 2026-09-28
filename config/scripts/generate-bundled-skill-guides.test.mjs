import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { BUNDLED_SKILL_GUIDES } from '../../src/cli/bundled-skill-guides'
import {
  CANONICAL_GUIDE_NAMES,
  GUIDE_ALIASES,
  STUB_TOPICS,
  assertAliasContract,
  buildArtifacts,
  frontmatterBlock,
  normalizeMarkdown,
  parseFrontmatter,
  readSharedStubBlocks,
  toPosixRelativePath,
  verifyArtifacts,
  writeArtifacts
} from './generate-bundled-skill-guides.mjs'
import { SHARED_STUB_SOURCE, renderSharedStubBody } from './skill-stub-composition.mjs'

const projectDir = path.resolve(import.meta.dirname, '..', '..')
const temporaryDirectories = []
const execFileAsync = promisify(execFile)
const GUIDE_REFERENCES = {
  orchestration: [
    'coordinator-loop.md',
    'legacy-contract-migration.md',
    'low-level-topology.md',
    'messaging-and-gates.md',
    'placement-and-remote.md',
    'recovery-and-cleanup.md',
    'worker-contract.md'
  ],
  'orca-cli': ['automations.md', 'browser.md', 'publishing.md'],
  'orca-per-workspace-env': [
    'docker-ssh.md',
    'failure-modes.md',
    'provider-vercel.md',
    'ssh-host.md',
    'windows-scripts.md'
  ]
}
const GUIDE_REFERENCE_PATHS = Object.entries(GUIDE_REFERENCES).flatMap(([guide, references]) =>
  references.map((reference) => [guide, reference])
)

async function readPerWorkspaceEnvCorpus() {
  const guideRoot = path.join(projectDir, 'skill-guides')
  const files = [
    path.join(guideRoot, 'orca-per-workspace-env.md'),
    ...GUIDE_REFERENCES['orca-per-workspace-env'].map((reference) =>
      path.join(guideRoot, 'orca-per-workspace-env', 'references', reference)
    )
  ]
  return (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n')
}

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-bundled-skill-guides-'))
  temporaryDirectories.push(root)
  await Promise.all([
    cp(path.join(projectDir, 'skill-guides'), path.join(root, 'skill-guides'), {
      recursive: true
    }),
    cp(path.join(projectDir, 'skill-stubs'), path.join(root, 'skill-stubs'), {
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
  it('projects stub topics as hybrid discovery stubs that reuse the guide frontmatter', async () => {
    expect(STUB_TOPICS.length).toBeGreaterThan(0)
    for (const name of STUB_TOPICS) {
      const source = await readFile(path.join(projectDir, 'skill-guides', `${name}.md`), 'utf8')
      const projection = await readFile(path.join(projectDir, 'skills', name, 'SKILL.md'), 'utf8')

      // The routing frontmatter is the unchanged discovery surface.
      expect(projection.startsWith(frontmatterBlock(source, `${name}.md`))).toBe(true)
      // The stub is a thin hybrid pointer, not the full guide.
      expect(projection).not.toEqual(source)
      expect(projection.length).toBeLessThan(source.length)
      expect(projection).toContain('discovery stub')
      expect(projection).toContain(`skills get ${name}`)
    }
  })

  it('uses the exported recipe id variable in per-workspace environment examples', async () => {
    // The guide is a kernel plus conditional references, so the env-var contract is asserted over
    // the whole corpus while the name-building recipe is pinned in the file that now carries it.
    const corpus = await readPerWorkspaceEnvCorpus()
    const vercelReference = await readFile(
      path.join(
        projectDir,
        'skill-guides',
        'orca-per-workspace-env',
        'references',
        'provider-vercel.md'
      ),
      'utf8'
    )

    expect(corpus).toContain('ORCA_RECIPE_ID')
    expect(corpus).not.toContain('ORCA_VM_RECIPE_ID')
    expect(vercelReference).toContain('recipe_id="${recipe_id//./-}"')
    expect(vercelReference).toContain('max_recipe_id_length=$((128 - ${#instance_id} - 6))')
    expect(vercelReference).toContain(
      'name="orca-${recipe_id:0:max_recipe_id_length}-${instance_id}"'
    )
  })

  it.skipIf(process.platform === 'win32')(
    'resolves snapshot cleanup through Orca user-data precedence',
    async () => {
      const source = await readFile(
        path.join(projectDir, 'skill-guides', 'orca-per-workspace-env.md'),
        'utf8'
      )
      const assignment =
        'orca_user_data_path="${ORCA_USER_DATA_PATH:-${XDG_CONFIG_HOME:-$HOME/.config}/orca}"'
      expect(source).toContain(assignment)
      const renderPath = async (env) =>
        (
          await execFileAsync(
            'bash',
            ['-u', '-c', `${assignment}; printf '%s' "$orca_user_data_path"`],
            {
              env
            }
          )
        ).stdout

      await expect(renderPath({ HOME: '/home/orca' })).resolves.toBe('/home/orca/.config/orca')
      await expect(
        renderPath({ HOME: '/home/orca', XDG_CONFIG_HOME: '/srv/config' })
      ).resolves.toBe('/srv/config/orca')
      await expect(
        renderPath({
          HOME: '/home/orca',
          XDG_CONFIG_HOME: '/srv/config',
          ORCA_USER_DATA_PATH: '/var/lib/orca-custom'
        })
      ).resolves.toBe('/var/lib/orca-custom')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps Vercel sandbox names valid while preserving the instance suffix',
    async () => {
      const source = await readFile(
        path.join(
          projectDir,
          'skill-guides',
          'orca-per-workspace-env',
          'references',
          'provider-vercel.md'
        ),
        'utf8'
      )
      const startMarker = 'recipe_id="${ORCA_RECIPE_ID:-vercel-sandbox}"'
      const endMarker = 'name="orca-${recipe_id:0:max_recipe_id_length}-${instance_id}"'
      const start = source.indexOf(startMarker)
      const endStart = source.indexOf(endMarker, start)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(endStart).toBeGreaterThan(start)
      const script = `${source.slice(start, endStart + endMarker.length)}\nprintf '%s' "$name"`
      const renderName = async (recipeId, instanceId) =>
        (
          await execFileAsync('bash', ['-u', '-c', script], {
            env: { ...process.env, ORCA_RECIPE_ID: recipeId, ORCA_VM_INSTANCE_ID: instanceId }
          })
        ).stdout

      const instanceId = 'orca-123e4567-e89b-12d3-a456-426614174000'
      const dotted = await renderName('provider.cloud_sandbox', instanceId)
      const maximum = await renderName(`a${'.'.repeat(63)}`, instanceId)
      const longInstanceId = 'i'.repeat(100)
      const capped = await renderName(
        'provider.cloud_sandbox.with.a.long.recipe.identifier',
        longInstanceId
      )

      expect(dotted).toBe(`orca-provider-cloud_sandbox-${instanceId}`)
      expect(maximum).toMatch(/^[a-zA-Z0-9_-]{1,128}$/u)
      expect(capped).toHaveLength(128)
      expect(capped.endsWith(`-${longInstanceId}`)).toBe(true)
    }
  )

  it('embeds compact guides, version-matched reference packages, and append-only aliases', async () => {
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
      expect(guide.aliases).toEqual(GUIDE_ALIASES[guide.name])
      const references = GUIDE_REFERENCES[guide.name]
      if (!references) {
        expect(guide.fullMarkdown).toBe(source)
        expect(guide.references).toEqual([])
        continue
      }
      // Why: the per-reference selector serves these verbatim, so an entry that
      // drifts from the file on disk ships a stale reference to every agent.
      expect(guide.references.map((reference) => reference.name)).toEqual(
        references.map((reference) => reference.replace(/\.md$/u, ''))
      )
      for (const reference of guide.references) {
        expect(reference.markdown).toBe(
          normalizeMarkdown(
            await readFile(
              path.join(
                projectDir,
                'skill-guides',
                guide.name,
                'references',
                `${reference.name}.md`
              ),
              'utf8'
            )
          )
        )
      }
      expect(guide.fullMarkdown).not.toBe(guide.markdown)
      expect(guide.fullMarkdown.length).toBeGreaterThan(guide.markdown.length)
      expect(guide.fullMarkdown.startsWith(source.trimEnd())).toBe(true)
      for (const reference of references) {
        const marker = `<!-- bundled-reference: references/${reference} -->`
        expect(guide.fullMarkdown.split(marker)).toHaveLength(2)
        expect(guide.fullMarkdown).toContain(
          await readFile(
            path.join(projectDir, 'skill-guides', guide.name, 'references', reference),
            'utf8'
          )
        )
      }
    }
  })

  it('keeps CLI guide examples safe across shells and Linux command names', async () => {
    for (const name of ['orca-cli', 'computer-use', 'orca-emulator', 'orca-emulator-android']) {
      const source = await readFile(path.join(projectDir, 'skill-guides', `${name}.md`), 'utf8')

      expect(source).toMatch(/^ORCA .+--json$/mu)
      // Why: bare command lines can launch GNOME Orca, while shell variables make
      // the same guide unusable from PowerShell and cmd.exe.
      expect(source).not.toMatch(/^orca /mu)
      expect(source).not.toMatch(/\$ORCA(?:_|\b)/u)
    }
  })

  // Why: `skills get` already ran on a resolved executable, so guide bodies point back at the
  // stub's resolution instead of carrying another copy of the ladder the stubs own.
  it('points every guide at the executable the stub resolved', async () => {
    // orchestration.md is rewritten to this contract by its own PR (#16904).
    for (const name of CANONICAL_GUIDE_NAMES.filter((name) => name !== 'orchestration')) {
      const source = await readFile(path.join(projectDir, 'skill-guides', `${name}.md`), 'utf8')

      expect(source.replace(/\s+/gu, ' '), name).toContain(
        'the executable you resolved in the stub'
      )
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
    for (const name of STUB_TOPICS) {
      const stubPath = path.join(root, 'skill-stubs', `${name}.md`)
      const stubSource = await readFile(stubPath, 'utf8')
      await writeFile(stubPath, stubSource.replaceAll('\n', '\r\n'))
    }
    const sharedStubPath = path.join(root, ...SHARED_STUB_SOURCE.split('/'))
    const sharedStubSource = await readFile(sharedStubPath, 'utf8')
    await writeFile(sharedStubPath, sharedStubSource.replaceAll('\n', '\r\n'))
    for (const [guide, reference] of GUIDE_REFERENCE_PATHS) {
      const referencePath = path.join(root, 'skill-guides', guide, 'references', reference)
      const source = await readFile(referencePath, 'utf8')
      await writeFile(referencePath, source.replaceAll('\n', '\r\n'))
    }

    const actual = await buildArtifacts(root)
    expect(actual.map((artifact) => artifact.content)).toEqual(
      expected.map((artifact) => artifact.content)
    )
  })

  it('pins guide sources, projections, and embedded output to LF in Git', async () => {
    const attributes = await readFile(path.join(projectDir, '.gitattributes'), 'utf8')
    expect(normalizeMarkdown(attributes)).toContain('/skill-guides/*.md text eol=lf\n')
    expect(normalizeMarkdown(attributes)).toContain('/skill-stubs/*.md text eol=lf\n')
    expect(normalizeMarkdown(attributes)).toContain('/skill-stubs/_shared/*.md text eol=lf\n')
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

  // Why: the stale-artifact assertions above only hit the Windows separator when the host is
  // Windows; injecting path.win32 makes the Linux/macOS shards catch the regression too.
  it('formats contributor-facing paths with forward slashes on every platform', () => {
    expect(
      toPosixRelativePath('C:\\repo', 'C:\\repo\\src\\cli\\bundled-skill-guides.ts', path.win32)
    ).toBe('src/cli/bundled-skill-guides.ts')
    expect(
      toPosixRelativePath('C:\\repo', 'C:\\repo\\skills\\computer-use\\SKILL.md', path.win32)
    ).toBe('skills/computer-use/SKILL.md')
    expect(toPosixRelativePath('/repo', '/repo/skills/computer-use/SKILL.md', path.posix)).toBe(
      'skills/computer-use/SKILL.md'
    )
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

  // G2: the resolver ladder is single-authored. Without this, a stub can re-inline it and
  // drift again exactly as the guide copies already did (#7904 lost `/usr/bin/orca`).
  it('projects one shared resolver fragment byte-for-byte into every stub', async () => {
    const blocks = await readSharedStubBlocks(projectDir)

    expect([...blocks.keys()]).toEqual(['resolver', 'no-guessing'])
    // Why: the guide copies of this warning had each dropped one half. #7904 is the incident
    // where bare `orca` started the screen reader talking on a user's Ubuntu box.
    expect(blocks.get('resolver').text).toContain('(`/usr/bin/orca`)')
    expect(blocks.get('resolver').text).toContain("starts speech on the user's machine")
    for (const name of STUB_TOPICS) {
      const projection = await readFile(path.join(projectDir, 'skills', name, 'SKILL.md'), 'utf8')
      for (const [id, block] of blocks) {
        expect(projection.split(block.text), `${name}/${id}`).toHaveLength(2)
      }
      // The `ORCA` placeholder rule is stated once, in the fragment, never restated.
      expect(projection.split('is a placeholder for the executable'), name).toHaveLength(2)
    }
  })

  // G2, second half: the ladder is pre-resolution guidance and belongs only to the stub —
  // every path that delivers a guide body has already resolved an executable. Guides keep
  // the `ORCA` placeholder rule. Red until the guide bodies drop their ladders; retiring
  // those also retires the ORCA_CLI_COMMAND/orca-dev/orca-ide assertions in
  // 'keeps CLI guide examples safe across shells and Linux command names' above, which
  // pin the opposite contract.
  it('keeps the CLI resolver ladder out of every guide body', async () => {
    for (const name of CANONICAL_GUIDE_NAMES) {
      const source = await readFile(path.join(projectDir, 'skill-guides', `${name}.md`), 'utf8')
      expect(source, name).not.toContain('ORCA_CLI_COMMAND')
    }
  })

  it('fails loudly on an unknown, missing, duplicated, or re-inlined shared block', async () => {
    const blocks = await readSharedStubBlocks(projectDir)
    const markers = [...blocks.keys()].map((id) => `<!-- shared: ${id} -->`).join('\n\n')
    const render = (body) => renderSharedStubBody(body, { blocks, sourcePath: 'skill-stubs/x.md' })

    expect(() => render(markers)).not.toThrow()
    expect(() => render(`${markers}\n\n<!-- shared: nope -->`)).toThrow('Unknown shared stub block')
    expect(() => render(markers.replace('<!-- shared: resolver -->\n\n', ''))).toThrow(
      'must insert <!-- shared: resolver --> exactly once; found 0'
    )
    expect(() => render(`${markers}\n\n<!-- shared: resolver -->`)).toThrow('found 2')
    expect(() => render(`${markers}\n\n${blocks.get('resolver').text}`)).toThrow(
      're-inlines shared block "resolver"'
    )
  })

  it('rejects non-Markdown and empty bundled references', async () => {
    const root = await createFixture()
    const referenceRoot = path.join(root, 'skill-guides', 'orca-cli', 'references')

    await writeFile(path.join(referenceRoot, 'notes.txt'), 'not a reference\n')
    await expect(buildArtifacts(root)).rejects.toThrow('Guide references must be Markdown files')
    await rm(path.join(referenceRoot, 'notes.txt'))
    await writeFile(path.join(referenceRoot, 'empty.md'), '\n')
    await expect(buildArtifacts(root)).rejects.toThrow('Guide reference is empty')
  })
})

// Why generalized: `orchestration-skill-guidance.test.mjs` pins this both-directions routing for
// orchestration alone. Any guide that grows a `references/` directory needs the same contract, or a
// reference can ship unroutable or a gate can route a file that does not exist.
describe('guide reference routing', () => {
  async function guidesWithReferences() {
    const guideRoot = path.join(projectDir, 'skill-guides')
    const entries = await readdir(guideRoot, { withFileTypes: true })
    const owners = []
    for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
      const referenceRoot = path.join(guideRoot, entry.name, 'references')
      const shipped = await readdir(referenceRoot).catch(() => null)
      if (shipped === null) {
        continue
      }
      owners.push({
        name: entry.name,
        referenceRoot,
        shipped: shipped.filter((file) => file.endsWith('.md')).sort()
      })
    }
    return owners
  }

  it('routes every shipped reference from its own guide, in both directions', async () => {
    const owners = await guidesWithReferences()
    // A vacuous loop would pass forever; orca-cli is a guide that owns references today.
    expect(owners.map((owner) => owner.name)).toContain('orca-cli')

    const mismatches = []
    for (const owner of owners) {
      const guidePath = path.join(projectDir, 'skill-guides', `${owner.name}.md`)
      const guide = await readFile(guidePath, 'utf8').catch(() => null)
      if (guide === null) {
        mismatches.push(`${owner.name}: references/ exists with no ${owner.name}.md beside it`)
        continue
      }
      const routed = [
        ...new Set([...guide.matchAll(/`references\/([^`]+\.md)`/gu)].map((match) => match[1]))
      ].sort()
      const unshipped = routed.filter((file) => !owner.shipped.includes(file))
      const unrouted = owner.shipped.filter((file) => !routed.includes(file))
      if (unshipped.length > 0) {
        mismatches.push(
          `${owner.name}: routes references that do not exist: ${unshipped.join(', ')}`
        )
      }
      if (unrouted.length > 0) {
        mismatches.push(`${owner.name}: ships references no gate routes: ${unrouted.join(', ')}`)
      }
    }
    expect(mismatches).toEqual([])
  })
})
