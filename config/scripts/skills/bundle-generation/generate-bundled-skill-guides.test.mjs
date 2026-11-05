import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CANONICAL_GUIDE_NAMES,
  STUB_TOPICS,
  assertAliasContract,
  buildArtifacts,
  normalizeMarkdown,
  readSharedStubBlocks,
  verifyArtifacts,
  writeArtifacts
} from './generate-bundled-skill-guides.mjs'
import { SHARED_STUB_SOURCE, renderSharedStubBody } from './skill-stub-composition.mjs'

const projectDir = path.resolve(import.meta.dirname, '../../..', '..')
const temporaryDirectories = []
const execFileAsync = promisify(execFile)
const GUIDE_REFERENCES = {
  orchestration: [
    'coordinator-loop.md',
    'low-level-topology.md',
    'messaging-and-gates.md',
    'placement-and-remote.md',
    'recovery-and-cleanup.md'
  ],
  'orca-cli': ['artifacts.md', 'automations.md', 'browser.md', 'plugins.md', 'skill-sharing.md'],
  'orca-per-workspace-env': [
    'docker-ssh.md',
    'failure-modes.md',
    'provider-vercel.md',
    'ssh-host.md',
    'windows-scripts.md'
  ],
  'orca-plugin-authoring': [
    'cli.md',
    'components.md',
    'events.md',
    'host-api.md',
    'manifest.md',
    'recipes.md',
    'testing.md',
    'workflow.md'
  ]
}
const GUIDE_REFERENCE_PATHS = Object.entries(GUIDE_REFERENCES).flatMap(([guide, references]) =>
  references.map((reference) => [guide, reference])
)

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
  it.skipIf(process.platform === 'win32')(
    'resolves the documented cleanup path from custom, XDG, and home settings',
    async () => {
      const source = await readFile(
        path.join(projectDir, 'skill-guides', 'orca-per-workspace-env.md'),
        'utf8'
      )
      const assignments = [...source.matchAll(/`(orca_user_data_path=[^`\r\n]+)`/gu)].map(
        (match) => match[1]
      )
      expect(assignments).toHaveLength(1)
      const script = `${assignments[0]}\nprintf '%s' "$orca_user_data_path"`
      const root = await mkdtemp(path.join(tmpdir(), 'orca-guide-cleanup-precedence-'))
      temporaryDirectories.push(root)
      const home = path.join(root, 'isolated home')
      const xdg = path.join(root, 'xdg config')
      const custom = path.join(root, 'custom runtime data')
      const homeDefault = path.join(home, '.config', 'orca')
      const xdgDefault = path.join(xdg, 'orca')
      const cases = [
        [{}, homeDefault],
        [{ XDG_CONFIG_HOME: xdg }, xdgDefault],
        [{ ORCA_USER_DATA_PATH: custom, XDG_CONFIG_HOME: xdg }, custom],
        [{ ORCA_USER_DATA_PATH: '', XDG_CONFIG_HOME: xdg }, xdgDefault],
        [{ XDG_CONFIG_HOME: '' }, homeDefault],
        [{ ORCA_USER_DATA_PATH: '', XDG_CONFIG_HOME: '' }, homeDefault]
      ]

      for (const [environment, expected] of cases) {
        const { stdout, stderr } = await execFileAsync(
          'bash',
          ['--noprofile', '--norc', '-u', '-c', script],
          {
            env: { HOME: home, ORCA_BACKGROUND_LAUNCH: '1', ...environment }
          }
        )
        expect(stdout).toBe(expected)
        expect(stderr).toBe('')
      }
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

  it.each([false, true])(
    'generates platform-identical output from CRLF guide sources (existing CRLF: %s)',
    async (alreadyCrlf) => {
      const expected = await buildArtifacts(projectDir)
      const root = await createFixture()
      if (alreadyCrlf) {
        for (const [guide, reference] of GUIDE_REFERENCE_PATHS) {
          const file = path.join(root, 'skill-guides', guide, 'references', reference)
          const source = normalizeMarkdown(await readFile(file, 'utf8'))
          await writeFile(file, source.replaceAll('\n', '\r\n'))
        }
      }
      for (const name of CANONICAL_GUIDE_NAMES) {
        const sourcePath = path.join(root, 'skill-guides', `${name}.md`)
        const source = await readFile(sourcePath, 'utf8')
        await writeFile(sourcePath, normalizeMarkdown(source).replaceAll('\n', '\r\n'))
      }
      for (const name of STUB_TOPICS) {
        const stubPath = path.join(root, 'skill-stubs', `${name}.md`)
        const stubSource = await readFile(stubPath, 'utf8')
        await writeFile(stubPath, normalizeMarkdown(stubSource).replaceAll('\n', '\r\n'))
      }
      const sharedStubPath = path.join(root, ...SHARED_STUB_SOURCE.split('/'))
      const sharedStubSource = await readFile(sharedStubPath, 'utf8')
      await writeFile(sharedStubPath, normalizeMarkdown(sharedStubSource).replaceAll('\n', '\r\n'))
      for (const [guide, reference] of GUIDE_REFERENCE_PATHS) {
        const referencePath = path.join(root, 'skill-guides', guide, 'references', reference)
        const source = await readFile(referencePath, 'utf8')
        await writeFile(referencePath, normalizeMarkdown(source).replaceAll('\n', '\r\n'))
      }

      const actual = await buildArtifacts(root)
      expect(actual.map((artifact) => artifact.content)).toEqual(
        expected.map((artifact) => artifact.content)
      )
    }
  )

  it('reports stale outputs and write mode repairs all projections', async () => {
    const root = await createFixture()
    const artifacts = await buildArtifacts(root)

    await expect(verifyArtifacts(artifacts, root)).rejects.toThrow(
      'src/cli/bundled-skill-guides.ts'
    )
    await writeArtifacts(artifacts)
    await expect(verifyArtifacts(artifacts, root)).resolves.toBeUndefined()

    await writeFile(path.join(root, 'skills', 'orca-computer-use', 'SKILL.md'), 'stale\n')
    await expect(verifyArtifacts(artifacts, root)).rejects.toThrow(
      'skills/orca-computer-use/SKILL.md'
    )
  })

  it('rejects mismatched source names and ambiguous aliases', async () => {
    const root = await createFixture()
    await writeFile(
      path.join(root, 'skill-guides', 'orca-computer-use.md'),
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

  it('fails loudly on an unknown, missing, duplicated, or re-inlined shared block', async () => {
    const blocks = await readSharedStubBlocks(projectDir)
    const markers = [...blocks.keys()].map((id) => `<!-- shared: ${id} -->`).join('\n\n')
    const render = (body) => renderSharedStubBody(body, { blocks, sourcePath: 'skill-stubs/x.md' })

    expect(() => render(markers)).not.toThrow()
    expect(() => render(`${markers}\n\n<!-- shared: nope -->`)).toThrow('Unknown shared stub block')
    expect(() => render(markers.replace('<!-- shared: resolver -->\n\n', ''))).toThrow(
      'must insert or omit <!-- shared: resolver --> exactly once; found 0'
    )
    expect(() => render(`${markers}\n\n<!-- shared: resolver -->`)).toThrow('found 2')
    expect(
      render(markers.replace('<!-- shared: resolver -->', '<!-- shared-omit: resolver -->'))
    ).not.toContain(blocks.get('resolver').text)
    expect(() => render(`${markers}\n\n<!-- shared-omit: resolver -->`)).toThrow('found 2')
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
