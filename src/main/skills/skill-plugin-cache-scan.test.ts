import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { scanKnownPluginSkillCandidates } from './skill-plugin-cache-scan'

const temporaryDirectories: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true })))
})

describe('plugin skill candidate scan', () => {
  it('stops at the package candidate budget and marks the scan incomplete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-skill-scan-'))
    temporaryDirectories.push(root)
    await Promise.all(
      ['one', 'two'].map(async (vendor) => {
        await mkdir(join(root, vendor, 'orca-cli'), { recursive: true })
        await writeFile(join(root, vendor, 'orca-cli', 'SKILL.md'), '# Orca CLI\n')
      })
    )

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']), 1)

    expect(result.candidates).toHaveLength(1)
    expect(result.issues).toEqual([{ path: root, reason: 'candidate-limit', errorCode: null }])
  })

  it('completes a real-shaped Codex cache without reporting coverage issues', async () => {
    // Mirrors ~/.codex/plugins/cache: <vendor>/<plugin>/<version>/.codex-plugin, with the
    // skill's own payload nesting well past the raw traversal depth (issue #10659).
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-real-shape-'))
    temporaryDirectories.push(root)
    const packageRoot = join(root, 'openai-bundled', 'sites', '0.1.31')
    const skill = join(packageRoot, 'skills', 'orca-cli')
    await mkdir(join(packageRoot, '.codex-plugin'), { recursive: true })
    await mkdir(
      join(skill, 'templates', 'vinext-starter', 'examples', 'd1', 'app', 'api', 'deep'),
      { recursive: true }
    )
    await writeFile(join(packageRoot, '.codex-plugin', 'plugin.json'), '{"skills":"./skills/"}\n')
    await writeFile(join(skill, 'SKILL.md'), '# Orca CLI\n')

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    expect(result).toEqual({ candidates: [{ name: 'orca-cli', path: skill }], issues: [] })
  })

  it('does not emit a plugin directory that only shares a skill name', async () => {
    // The cached plugin is itself called orca-cli. Only the SKILL.md below it is a skill.
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-name-collision-'))
    temporaryDirectories.push(root)
    const packageRoot = join(root, 'openai-bundled', 'orca-cli', '1.0.0')
    const skill = join(packageRoot, 'skills', 'orca-cli')
    await mkdir(join(packageRoot, '.codex-plugin'), { recursive: true })
    await mkdir(skill, { recursive: true })
    await writeFile(join(packageRoot, '.codex-plugin', 'plugin.json'), '{"skills":"./skills/"}\n')
    await writeFile(join(skill, 'SKILL.md'), '# Orca CLI\n')

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    expect(result).toEqual({ candidates: [{ name: 'orca-cli', path: skill }], issues: [] })
  })

  it('does not emit a bare known-name directory that carries no SKILL.md', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-bare-name-'))
    temporaryDirectories.push(root)
    await mkdir(join(root, 'vendor', 'orca-cli', 'assets'), { recursive: true })

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    expect(result).toEqual({ candidates: [], issues: [] })
  })

  it('stops descending once a skill package payload exceeds the nested skill budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-payload-prune-'))
    temporaryDirectories.push(root)
    const packageRoot = join(root, 'vendor', 'plugin', '1.0.0')
    const skill = join(packageRoot, 'skills', 'sites-building')
    const buried = join(skill, 'templates', 'starter', 'examples', 'orca-cli')
    await mkdir(join(packageRoot, '.codex-plugin'), { recursive: true })
    await mkdir(buried, { recursive: true })
    await writeFile(join(packageRoot, '.codex-plugin', 'plugin.json'), '{"skills":"./skills"}\n')
    await writeFile(join(skill, 'SKILL.md'), '# Sites building\n')
    await writeFile(join(buried, 'SKILL.md'), '# Orca CLI\n')

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    // Why: pruning payload is a topology decision, so it must stay silent rather than
    // surface as a coverage issue the user is asked to act on.
    expect(result).toEqual({ candidates: [], issues: [] })
  })

  it('reports a depth-truncated subtree as scan coverage instead of a skill candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-skill-depth-'))
    temporaryDirectories.push(root)
    const segments = Array.from({ length: 11 }, (_, index) => `level-${index}`)
    const hiddenSkill = join(root, ...segments, 'orca-cli')
    await mkdir(hiddenSkill, { recursive: true })

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    expect(result.candidates).toEqual([])
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({ reason: 'depth-limit', errorCode: null })
    expect(hiddenSkill.startsWith(result.issues[0]?.path ?? '')).toBe(true)
  })

  it('does not scan dependency packages for plugin skill entrypoints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-dependencies-'))
    temporaryDirectories.push(root)
    await mkdir(
      join(
        root,
        'vendor',
        'plugin',
        'scripts',
        'node_modules',
        ...Array.from({ length: 12 }, (_, index) => `level-${index}`)
      ),
      { recursive: true }
    )

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    expect(result).toEqual({ candidates: [], issues: [] })
  })

  it('scans only declared Codex plugin skill roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-manifest-roots-'))
    temporaryDirectories.push(root)
    const packageRoot = join(root, 'vendor', 'plugin', '1.0.0')
    const candidate = join(packageRoot, 'custom-skills', 'group', 'orca-cli')
    await mkdir(join(packageRoot, '.codex-plugin'), { recursive: true })
    await mkdir(candidate, { recursive: true })
    await mkdir(
      join(packageRoot, 'payload', ...Array.from({ length: 12 }, (_, index) => `level-${index}`)),
      { recursive: true }
    )
    await writeFile(
      join(packageRoot, '.codex-plugin', 'plugin.json'),
      '{"skills":["./custom-skills","./skills"]}\n'
    )
    await writeFile(join(candidate, 'SKILL.md'), '# Orca CLI\n')

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    expect(result).toEqual({
      candidates: [{ name: 'orca-cli', path: candidate }],
      issues: []
    })
  })

  it('uses the default skills root for compatible manifests without a skills field', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-default-root-'))
    temporaryDirectories.push(root)
    const packageRoot = join(root, 'vendor', 'plugin', '1.0.0')
    const candidate = join(packageRoot, 'skills', 'nested', 'orca-cli')
    await mkdir(join(packageRoot, '.claude-plugin'), { recursive: true })
    await mkdir(candidate, { recursive: true })
    await writeFile(join(packageRoot, '.claude-plugin', 'plugin.json'), '{"name":"plugin"}\n')
    await writeFile(join(candidate, 'SKILL.md'), '# Orca CLI\n')

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    expect(result).toEqual({
      candidates: [{ name: 'orca-cli', path: candidate }],
      issues: []
    })
  })

  it('discovers nested skill packages recursively within declared roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-skill-boundary-'))
    temporaryDirectories.push(root)
    const packageRoot = join(root, 'vendor', 'plugin', '1.0.0')
    const skillRoot = join(packageRoot, 'skills', 'sites-building')
    await mkdir(join(packageRoot, '.cursor-plugin'), { recursive: true })
    await mkdir(join(skillRoot, 'templates', 'orca-cli'), { recursive: true })
    await writeFile(join(packageRoot, '.cursor-plugin', 'plugin.json'), '{"skills":"./skills"}\n')
    await writeFile(join(skillRoot, 'SKILL.md'), '# Sites building\n')
    await writeFile(join(skillRoot, 'templates', 'orca-cli', 'SKILL.md'), '# Orca CLI\n')

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    expect(result).toEqual({
      candidates: [{ name: 'orca-cli', path: join(skillRoot, 'templates', 'orca-cli') }],
      issues: []
    })
  })

  it('rejects Windows parent traversal and falls back to the default skills root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-windows-parent-'))
    temporaryDirectories.push(root)
    const packageRoot = join(root, 'vendor', 'plugin', '1.0.0')
    const candidate = join(packageRoot, 'skills', 'orca-cli')
    await mkdir(join(packageRoot, '.codex-plugin'), { recursive: true })
    await mkdir(candidate, { recursive: true })
    await writeFile(
      join(packageRoot, '.codex-plugin', 'plugin.json'),
      '{"skills":"./..\\\\outside"}\n'
    )
    await writeFile(join(candidate, 'SKILL.md'), '# Orca CLI\n')

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    expect(result).toEqual({
      candidates: [{ name: 'orca-cli', path: candidate }],
      issues: []
    })
  })

  it('falls through empty manifest directories to the first manifest file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-manifest-precedence-'))
    temporaryDirectories.push(root)
    const packageRoot = join(root, 'vendor', 'plugin', '1.0.0')
    const candidate = join(packageRoot, 'custom-skills', 'orca-cli')
    await mkdir(join(packageRoot, '.codex-plugin'), { recursive: true })
    await mkdir(join(packageRoot, '.claude-plugin'), { recursive: true })
    await mkdir(candidate, { recursive: true })
    await mkdir(
      join(packageRoot, 'payload', ...Array.from({ length: 12 }, (_, index) => `level-${index}`)),
      { recursive: true }
    )
    await writeFile(
      join(packageRoot, '.claude-plugin', 'plugin.json'),
      '{"skills":"./custom-skills"}\n'
    )
    await writeFile(join(candidate, 'SKILL.md'), '# Orca CLI\n')

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    expect(result).toEqual({
      candidates: [{ name: 'orca-cli', path: candidate }],
      issues: []
    })
  })

  it('counts declared skill roots against the scan entry budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-manifest-budget-'))
    temporaryDirectories.push(root)
    const packageRoot = join(root, 'vendor', 'plugin', '1.0.0')
    await mkdir(join(packageRoot, '.codex-plugin'), { recursive: true })
    await writeFile(
      join(packageRoot, '.codex-plugin', 'plugin.json'),
      JSON.stringify({
        skills: Array.from({ length: 16_385 }, (_, index) => `./m${index}`)
      })
    )

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    expect(result.candidates).toEqual([])
    expect(result.issues).toEqual([{ path: root, reason: 'entry-limit', errorCode: null }])
  })

  it('keeps valid roots when a skills array contains an invalid value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-invalid-root-array-'))
    temporaryDirectories.push(root)
    const packageRoot = join(root, 'vendor', 'plugin', '1.0.0')
    const defaultCandidate = join(packageRoot, 'skills', 'orca-cli')
    const declaredCandidate = join(packageRoot, 'custom-skills', 'orca-cli')
    await mkdir(join(packageRoot, '.codex-plugin'), { recursive: true })
    await mkdir(defaultCandidate, { recursive: true })
    await mkdir(declaredCandidate, { recursive: true })
    await writeFile(
      join(packageRoot, '.codex-plugin', 'plugin.json'),
      '{"skills":["./custom-skills",7]}\n'
    )
    await writeFile(join(defaultCandidate, 'SKILL.md'), '# Wrong root\n')
    await writeFile(join(declaredCandidate, 'SKILL.md'), '# Orca CLI\n')

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    expect(result).toEqual({
      candidates: [{ name: 'orca-cli', path: declaredCandidate }],
      issues: []
    })
  })

  it('does not reset the depth budget across nested plugin manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-nested-manifests-'))
    temporaryDirectories.push(root)
    let pluginRoot = join(root, 'vendor', 'plugin', '1.0.0')
    for (let index = 0; index < 8; index += 1) {
      await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true })
      await writeFile(join(pluginRoot, '.codex-plugin', 'plugin.json'), '{"skills":"./skills"}\n')
      pluginRoot = join(pluginRoot, 'skills', `nested-${index}`)
    }
    const hiddenCandidate = join(pluginRoot, 'orca-cli')
    await mkdir(hiddenCandidate, { recursive: true })
    await writeFile(join(hiddenCandidate, 'SKILL.md'), '# Orca CLI\n')

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    expect(result.candidates).toEqual([])
    expect(result.issues).toContainEqual(
      expect.objectContaining({ reason: 'depth-limit', errorCode: null })
    )
  })

  it('ignores non-directory manifest markers when selecting precedence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-manifest-marker-file-'))
    temporaryDirectories.push(root)
    const packageRoot = join(root, 'vendor', 'plugin', '1.0.0')
    const candidate = join(packageRoot, 'custom-skills', 'orca-cli')
    await mkdir(packageRoot, { recursive: true })
    await mkdir(join(packageRoot, '.claude-plugin'), { recursive: true })
    await mkdir(candidate, { recursive: true })
    await mkdir(
      join(packageRoot, 'payload', ...Array.from({ length: 12 }, (_, index) => `level-${index}`)),
      { recursive: true }
    )
    await writeFile(join(packageRoot, '.codex-plugin'), 'not a directory\n')
    await writeFile(
      join(packageRoot, '.claude-plugin', 'plugin.json'),
      '{"skills":"./custom-skills"}\n'
    )
    await writeFile(join(candidate, 'SKILL.md'), '# Orca CLI\n')

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    expect(result).toEqual({
      candidates: [{ name: 'orca-cli', path: candidate }],
      issues: []
    })
  })

  it('reports manifests that exceed the bounded read limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-large-manifest-'))
    temporaryDirectories.push(root)
    const manifestPath = join(root, 'vendor', 'plugin', '.codex-plugin', 'plugin.json')
    await mkdir(join(root, 'vendor', 'plugin', '.codex-plugin'), { recursive: true })
    await writeFile(manifestPath, ' '.repeat(256 * 1024 + 1))

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    expect(result.issues).toContainEqual({
      path: manifestPath,
      reason: 'manifest-limit',
      errorCode: null
    })
  })

  it('reports a symlink target that cannot be inspected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-symlink-error-'))
    temporaryDirectories.push(root)
    const linkPath = join(root, 'loop')
    await symlink('loop', linkPath, 'dir')

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    expect(result.issues).toContainEqual({
      path: linkPath,
      reason: 'io-error',
      errorCode: 'ELOOP'
    })
  })

  it('keeps a dangling known-name symlink from a declared skill root as a candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-declared-dangling-symlink-'))
    temporaryDirectories.push(root)
    const packageRoot = join(root, 'vendor', 'plugin')
    const candidate = join(packageRoot, 'skills', 'orca-cli')
    await mkdir(join(packageRoot, '.codex-plugin'), { recursive: true })
    await mkdir(join(packageRoot, 'skills'), { recursive: true })
    await writeFile(join(packageRoot, '.codex-plugin', 'plugin.json'), '{"skills":"./skills"}\n')
    await symlink('missing-target', candidate, 'dir')

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    expect(result).toEqual({
      candidates: [{ name: 'orca-cli', path: candidate }],
      issues: []
    })
  })

  it('does not follow directory symlinks outside the plugin cache', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'orca-plugin-symlink-outside-'))
    temporaryDirectories.push(parent)
    const root = join(parent, 'cache')
    const outside = join(parent, 'outside')
    const linkPath = join(root, 'vendor')
    await mkdir(join(outside, 'orca-cli'), { recursive: true })
    await mkdir(root, { recursive: true })
    await writeFile(join(outside, 'orca-cli', 'SKILL.md'), '# Orca CLI\n')
    await symlink(outside, linkPath, 'dir')

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    expect(result).toEqual({
      candidates: [],
      issues: [{ path: linkPath, reason: 'outside-root', errorCode: null }]
    })
  })

  it('does not follow a SKILL.md symlink outside the plugin cache', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'orca-plugin-skill-file-outside-'))
    temporaryDirectories.push(parent)
    const root = join(parent, 'cache')
    const skill = join(root, 'vendor', 'orca-cli')
    const outsideSkillFile = join(parent, 'outside', 'SKILL.md')
    await mkdir(skill, { recursive: true })
    await mkdir(join(parent, 'outside'), { recursive: true })
    await writeFile(outsideSkillFile, '# Orca CLI\n')
    await symlink(outsideSkillFile, join(skill, 'SKILL.md'), 'file')

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    expect(result).toEqual({
      candidates: [],
      issues: [{ path: join(skill, 'SKILL.md'), reason: 'outside-root', errorCode: null }]
    })
  })

  it('does not read manifest symlinks outside the plugin cache', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'orca-plugin-manifest-outside-'))
    temporaryDirectories.push(parent)
    const root = join(parent, 'cache')
    const outsideManifest = join(parent, 'plugin.json')
    const manifestPath = join(root, '.codex-plugin', 'plugin.json')
    await mkdir(join(root, '.codex-plugin'), { recursive: true })
    await writeFile(outsideManifest, '{"skills":"./outside"}\n')
    await symlink(outsideManifest, manifestPath, 'file')

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    expect(result).toEqual({
      candidates: [],
      issues: [{ path: manifestPath, reason: 'outside-root', errorCode: null }]
    })
  })

  it.skipIf(process.platform === 'win32')(
    'does not block on a manifest FIFO',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-plugin-manifest-fifo-'))
      temporaryDirectories.push(root)
      const manifestPath = join(root, '.codex-plugin', 'plugin.json')
      await mkdir(join(root, '.codex-plugin'), { recursive: true })
      await execFileAsync('mkfifo', [manifestPath])

      const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

      expect(result).toEqual({ candidates: [], issues: [] })
    },
    1_000
  )
})
