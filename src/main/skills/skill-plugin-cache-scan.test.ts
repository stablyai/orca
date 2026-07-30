import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { isSkillScanIssueNeedingAttention } from '../../shared/skill-freshness'
import {
  MAXIMUM_PLUGIN_SCAN_ATTENTION_ISSUES,
  MAXIMUM_PLUGIN_SCAN_DEPTH,
  MAXIMUM_PLUGIN_SCAN_ISSUES,
  scanKnownPluginSkillCandidates
} from './skill-plugin-cache-scan'

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

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']), {
      maximumCandidates: 1
    })

    expect(result.candidates).toHaveLength(1)
    expect(result.issues).toEqual([{ path: root, reason: 'candidate-limit', errorCode: null }])
  })

  it('stops at the entry budget and reports the truncation at the scan root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-entry-limit-'))
    temporaryDirectories.push(root)
    await Promise.all(
      ['one', 'two'].map(async (vendor) => {
        await mkdir(join(root, vendor, 'orca-cli'), { recursive: true })
        await writeFile(join(root, vendor, 'orca-cli', 'SKILL.md'), '# Orca CLI\n')
      })
    )

    // Budget: the root's two vendor dirents, one's, and its skill's — so the count is
    // crossed inside 'two', not at the root. That is what pins the issue to the scan
    // root the dialog can name rather than whichever directory happened to cross it.
    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']), {
      maximumEntries: 4
    })

    // Why: the second vendor's skill goes unseen. The issue is all that stops the dialog
    // reporting all-clear over a scan that never reached it.
    expect(result.candidates).toEqual([{ name: 'orca-cli', path: join(root, 'one', 'orca-cli') }])
    expect(result.issues).toEqual([{ path: root, reason: 'entry-limit', errorCode: null }])
  })

  it('stops walking the directory whose read crossed the entry budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-entry-limit-stop-'))
    temporaryDirectories.push(root)
    // Why: read off the depth bound rather than hardcoded. The deepest directory has to
    // sit exactly at it, so its children are the first thing a walk that failed to stop
    // would reject on depth — one level shallower and the mutant walks them silently.
    const segments = Array.from(
      { length: MAXIMUM_PLUGIN_SCAN_DEPTH },
      (_, index) => `level-${index}`
    )
    await Promise.all(
      ['a', 'b'].map((name) => mkdir(join(root, ...segments, name), { recursive: true }))
    )

    // Budget: one dirent per level down to the deepest directory, plus the first of its
    // two children — so the count is crossed on the second, with the first already read.
    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']), {
      maximumEntries: segments.length + 1
    })

    // Why: the entries already read before the bound must not still be descended. A scan
    // that keeps walking reports the leftovers as depth-truncated, which is a coverage
    // failure the walk never observed — exactly the kind of unaccountable claim #10918 was.
    expect(result.candidates).toEqual([])
    expect(result.issues).toEqual([{ path: root, reason: 'entry-limit', errorCode: null }])
  })

  // Why: a declared root costs a resolve before it can be rejected, and a root that does
  // not exist reads no dirent at all — so the dirent guard never sees a manifest that
  // spends the whole scan on missing paths. Only the resolve guard bounds that, and only
  // this shape lets its threshold be read off the entry count instead of assumed.
  async function createManifestWithMissingSkillRoots(): Promise<{
    root: string
    candidate: string
  }> {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-entry-limit-declared-'))
    temporaryDirectories.push(root)
    // Why: the manifest sits under a vendor directory, not at the scan root, so the
    // directory whose declared roots cross the budget is not the root the issue names.
    const packageRoot = join(root, 'vendor')
    const candidate = join(packageRoot, 'a-skills', 'orca-cli')
    await mkdir(join(packageRoot, '.codex-plugin'), { recursive: true })
    await mkdir(candidate, { recursive: true })
    await writeFile(
      join(packageRoot, '.codex-plugin', 'plugin.json'),
      '{"skills":["./a-skills","./missing-one","./missing-two"]}\n'
    )
    await writeFile(join(candidate, 'SKILL.md'), '# Orca CLI\n')
    return { root, candidate }
  }

  // Why: the scan reads exactly eight entries here — the root's dirent, the vendor's two,
  // a-skills' and its skill's, then one resolve per declared root. Both budgets below are
  // stated against that count so each guard's threshold is asserted, not just its firing.
  const DECLARED_ROOT_SCAN_ENTRIES = 8

  it('stops at the entry budget while resolving declared skill roots', async () => {
    const { root, candidate } = await createManifestWithMissingSkillRoots()

    // Why: one short of the full count, so only the last declared root's resolve crosses
    // it. A guard that admitted that root would run the scan to completion and report
    // nothing, which is what makes the issue below an assertion on the threshold.
    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']), {
      maximumEntries: DECLARED_ROOT_SCAN_ENTRIES - 1
    })

    // Why: the declared root that exists was fully walked, so the bound is being crossed by
    // a resolve of the roots after it — not by the dirent loop stopping the scan early.
    expect(result.candidates).toEqual([{ name: 'orca-cli', path: candidate }])
    expect(result.issues).toEqual([{ path: root, reason: 'entry-limit', errorCode: null }])
  })

  it('resolves the last declared skill root when the entry budget is exactly spent', async () => {
    const { root, candidate } = await createManifestWithMissingSkillRoots()

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']), {
      maximumEntries: DECLARED_ROOT_SCAN_ENTRIES
    })

    // Why: a budget the scan fits inside is not a truncation. Firing one entry early would
    // pin the same unclearable attention #10918 did, on a scan that missed nothing.
    expect(result.candidates).toEqual([{ name: 'orca-cli', path: candidate }])
    expect(result.issues).toEqual([])
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

  // Why this exists: the bound below is a deliberate tradeoff, and only the miss side of
  // it was covered. Descending further would spend the entry budget on vendor payload —
  // the cost that caused the false-attention root collapse in #10865 — while missing a
  // copy only ever costs a Details row, because a plugin-cache placement is not
  // convergeable by any update command. So the failure direction is silence, which is the
  // safe one. Pinning BOTH sides means raising or lowering the bound has to be deliberate
  // rather than an accident of refactoring. See #11454.
  it.each([
    [0, true],
    [1, true],
    [2, true],
    [3, false],
    [4, false]
  ])(
    'finds a nested skill %i level(s) below a package: %s',
    async (intermediateDepth, expectFound) => {
      const root = await mkdtemp(join(tmpdir(), 'orca-plugin-nested-depth-'))
      temporaryDirectories.push(root)
      const packageRoot = join(root, 'vendor', 'plugin', '1.0.0')
      const hostSkill = join(packageRoot, 'skills', 'host-skill')
      await mkdir(join(packageRoot, '.codex-plugin'), { recursive: true })
      await mkdir(hostSkill, { recursive: true })
      await writeFile(join(packageRoot, '.codex-plugin', 'plugin.json'), '{"skills":"./skills"}\n')
      await writeFile(join(hostSkill, 'SKILL.md'), '# Host skill\n')

      let parent = hostSkill
      for (let level = 1; level <= intermediateDepth; level += 1) {
        parent = join(parent, `nested-${level}`)
      }
      const candidate = join(parent, 'orca-cli')
      await mkdir(candidate, { recursive: true })
      await writeFile(join(candidate, 'SKILL.md'), '# Orca CLI\n')

      const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

      expect(result.candidates).toEqual(expectFound ? [{ name: 'orca-cli', path: candidate }] : [])
      // Why: pruned payload must never surface as a coverage issue either way — that is
      // what keeps an ordinary large plugin cache from reporting a permanent problem.
      expect(result.issues).toEqual([])
    }
  )

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

  it('falls back to traversal when a manifest skills path is invalid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-invalid-declared-root-'))
    temporaryDirectories.push(root)
    const packageRoot = join(root, 'vendor', 'plugin', '1.0.0')
    const candidate = join(packageRoot, 'custom-skills', 'orca-cli')
    await mkdir(join(packageRoot, '.codex-plugin'), { recursive: true })
    await mkdir(candidate, { recursive: true })
    await writeFile(
      join(packageRoot, '.codex-plugin', 'plugin.json'),
      '{"skills":"custom-skills"}\n'
    )
    await writeFile(join(candidate, 'SKILL.md'), '# Orca CLI\n')

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    expect(result).toEqual({
      candidates: [{ name: 'orca-cli', path: candidate }],
      issues: []
    })
  })

  it('does not traverse plugin payload when the default skills root is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-missing-default-root-'))
    temporaryDirectories.push(root)
    const packageRoot = join(root, 'vendor', 'plugin', '1.0.0')
    await mkdir(join(packageRoot, '.codex-plugin'), { recursive: true })
    await mkdir(
      join(packageRoot, 'commands', ...Array.from({ length: 11 }, (_, index) => `level-${index}`)),
      { recursive: true }
    )
    await writeFile(join(packageRoot, '.codex-plugin', 'plugin.json'), '{"name":"plugin"}\n')

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    expect(result).toEqual({ candidates: [], issues: [] })
  })

  it('does not traverse plugin payload when the manifest declares no skill roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-empty-skill-roots-'))
    temporaryDirectories.push(root)
    const packageRoot = join(root, 'vendor', 'plugin', '1.0.0')
    await mkdir(join(packageRoot, '.codex-plugin'), { recursive: true })
    await mkdir(
      join(packageRoot, 'commands', ...Array.from({ length: 11 }, (_, index) => `level-${index}`)),
      { recursive: true }
    )
    await writeFile(join(packageRoot, '.codex-plugin', 'plugin.json'), '{"skills":[]}\n')

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    expect(result).toEqual({ candidates: [], issues: [] })
  })

  it('discovers nested skill packages recursively within declared roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-skill-boundary-'))
    temporaryDirectories.push(root)
    const packageRoot = join(root, 'vendor', 'plugin', '1.0.0')
    const skillRoot = join(packageRoot, 'skills', 'sites-building')
    await mkdir(join(packageRoot, '.claude-plugin'), { recursive: true })
    await mkdir(join(skillRoot, 'templates', 'orca-cli'), { recursive: true })
    await writeFile(join(packageRoot, '.claude-plugin', 'plugin.json'), '{"skills":"./skills"}\n')
    await writeFile(join(skillRoot, 'SKILL.md'), '# Sites building\n')
    await writeFile(join(skillRoot, 'templates', 'orca-cli', 'SKILL.md'), '# Orca CLI\n')

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    expect(result).toEqual({
      candidates: [{ name: 'orca-cli', path: join(skillRoot, 'templates', 'orca-cli') }],
      issues: []
    })
  })

  it('rejects Windows parent traversal without hiding the default skills root', async () => {
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

  it('bounds how many skill roots one manifest can declare', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-manifest-budget-'))
    temporaryDirectories.push(root)
    const packageRoot = join(root, 'vendor', 'plugin', '1.0.0')
    const manifestPath = join(packageRoot, '.codex-plugin', 'plugin.json')
    const candidate = join(packageRoot, 'r0000', 'orca-cli')
    await mkdir(join(packageRoot, '.codex-plugin'), { recursive: true })
    await mkdir(candidate, { recursive: true })
    await writeFile(join(candidate, 'SKILL.md'), '# Orca CLI\n')
    await writeFile(
      manifestPath,
      JSON.stringify({
        skills: Array.from({ length: 4096 }, (_, index) => `./r${String(index).padStart(4, '0')}`)
      })
    )

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    // Why: resolving declared roots bypasses the entry budget, so without this cap the
    // manifest alone decides how long the scan runs. Falling back to the bounded walk
    // still finds the skill, so the cap costs coverage nothing.
    expect(result.candidates).toEqual([{ name: 'orca-cli', path: candidate }])
    expect(result.issues).toEqual([
      { path: manifestPath, reason: 'manifest-limit', errorCode: null }
    ])
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

  // Why (this and every other skipIf below): creating a symlink on Windows needs
  // elevation or Developer Mode, so these would fail EPERM in setup rather than
  // exercise the behavior under test. The non-symlink cases still run there.
  it.skipIf(process.platform === 'win32')(
    'reports a symlink target that cannot be inspected',
    async () => {
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
    }
  )

  it.skipIf(process.platform === 'win32')(
    'preserves read failures when the scan issue limit is reached',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-plugin-issue-limit-'))
      temporaryDirectories.push(root)
      await Promise.all(
        Array.from({ length: 16 }, async (_, index) => {
          const name = `loop-${index.toString().padStart(2, '0')}`
          await symlink(name, join(root, name), 'dir')
        })
      )
      const packageRoot = join(root, 'zz-package')
      await mkdir(join(packageRoot, '.codex-plugin'), { recursive: true })
      await symlink('SKILL.md', join(packageRoot, 'SKILL.md'), 'file')
      await symlink('plugin.json', join(packageRoot, '.codex-plugin', 'plugin.json'), 'file')

      const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

      expect(result.issues).toContainEqual({
        path: join(root, 'loop-00'),
        reason: 'io-error',
        errorCode: 'ELOOP'
      })
      expect(result.issues).toContainEqual({
        path: root,
        reason: 'issue-limit',
        errorCode: null
      })
      expect(result.issues.filter((issue) => issue.reason === 'issue-limit')).toHaveLength(1)
    }
  )

  // Why: linking skills out of the cache is ordinary vendor packaging, so 'outside-root' is
  // what fills the display budget on a real install — before any read failure is reached.
  async function createCacheBehindSpentBudget(prefix: string, loopCount: number): Promise<string> {
    const parent = await mkdtemp(join(tmpdir(), prefix))
    temporaryDirectories.push(parent)
    const root = join(parent, 'cache')
    const outside = join(parent, 'outside')
    await mkdir(outside, { recursive: true })
    await mkdir(root, { recursive: true })
    await Promise.all(
      Array.from({ length: MAXIMUM_PLUGIN_SCAN_ISSUES }, (_, index) =>
        symlink(outside, join(root, `aa-linked-${index.toString().padStart(2, '0')}`), 'dir')
      )
    )
    // Sorts after the links, so these are read once the budget is already spent.
    await Promise.all(
      Array.from({ length: loopCount }, (_, index) => {
        const name = `zz-loop-${index.toString().padStart(2, '0')}`
        return symlink(name, join(root, name), 'dir')
      })
    )
    return root
  }

  it.skipIf(process.platform === 'win32')(
    'keeps a read failure that lands after the display budget is spent',
    async () => {
      const root = await createCacheBehindSpentBudget('orca-plugin-attention-eviction-', 1)

      const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

      // Why: a read failure is the only issue that can take the headline off "all up to
      // date". Evicting it for display budget reports all-clear over a path that could be
      // hiding a stale copy — the bounds that filled the budget say nothing about it.
      expect(result.issues).toContainEqual({
        path: join(root, 'zz-loop-00'),
        reason: 'io-error',
        errorCode: 'ELOOP'
      })
      const inventoryIssues = result.issues.map((issue) => ({
        rootId: 'plugin-cache',
        sourceLabel: 'Plugin cache',
        ...issue
      }))
      expect(inventoryIssues.some(isSkillScanIssueNeedingAttention)).toBe(true)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'bounds how many read failures outrank the display budget',
    async () => {
      const root = await createCacheBehindSpentBudget(
        'orca-plugin-attention-bound-',
        MAXIMUM_PLUGIN_SCAN_ATTENTION_ISSUES + 4
      )

      const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

      // Why: outranking the budget is what makes this class unbounded, so a tree full of
      // unreadable folders must not be able to pin one issue per folder in memory.
      expect(result.issues.filter((issue) => issue.reason === 'io-error')).toHaveLength(
        MAXIMUM_PLUGIN_SCAN_ATTENTION_ISSUES
      )
      expect(result.issues).toContainEqual({ path: root, reason: 'issue-limit', errorCode: null })
    }
  )

  it('reports the bound that ended the walk even with the issue budget spent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-truncating-issue-'))
    temporaryDirectories.push(root)
    await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        mkdir(
          join(
            root,
            `deep-${index.toString().padStart(2, '0')}`,
            ...Array.from({ length: 11 }, (_, level) => `level-${level}`)
          ),
          { recursive: true }
        )
      )
    )
    await Promise.all(
      ['zz-one', 'zz-two'].map(async (vendor) => {
        await mkdir(join(root, vendor, 'orca-cli'), { recursive: true })
        await writeFile(join(root, vendor, 'orca-cli', 'SKILL.md'), '# Orca CLI\n')
      })
    )

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']), {
      maximumCandidates: 1
    })

    // Why: the deep trees above exist to spend the display budget, so assert it is full —
    // otherwise this passes with budget to spare and stops covering the case it is named
    // for. Not 'issue-limit': that only appears when a non-required issue is dropped, and
    // the truncating bound below bypasses the budget instead of being dropped by it.
    expect(result.issues.filter((issue) => issue.reason === 'depth-limit')).toHaveLength(
      MAXIMUM_PLUGIN_SCAN_ISSUES
    )
    // Why: losing this one to the display budget is what lets a scan that stopped early
    // report all-clear — the bounds that merely skipped a folder say nothing about it.
    expect(result.issues).toContainEqual({ path: root, reason: 'candidate-limit', errorCode: null })
  })

  it('keeps scanning past the issue budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-plugin-issue-budget-coverage-'))
    temporaryDirectories.push(root)
    const candidate = join(root, 'zz-package', 'skills', 'orca-cli')
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        mkdir(
          join(
            root,
            `deep-${index.toString().padStart(2, '0')}`,
            ...Array.from({ length: 11 }, (_, level) => `level-${level}`)
          ),
          { recursive: true }
        )
      )
    )
    await mkdir(candidate, { recursive: true })
    await writeFile(join(candidate, 'SKILL.md'), '# Orca CLI\n')

    const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

    // Why: the issue budget bounds what the dialog lists, not how far the walk reaches.
    // Ending the scan there would drop real copies and still report all-clear, because
    // none of the bounds that filled the budget raise attention.
    expect(result.candidates).toEqual([{ name: 'orca-cli', path: candidate }])
    expect(result.issues).toContainEqual({ path: root, reason: 'issue-limit', errorCode: null })
  })

  it.skipIf(process.platform === 'win32')(
    'still names a fail-closed candidate once the issue budget is spent',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-plugin-issue-budget-candidate-'))
      temporaryDirectories.push(root)
      const packageRoot = join(root, 'zz-package')
      const candidate = join(packageRoot, 'skills', 'orca-cli')
      await Promise.all(
        Array.from({ length: 16 }, (_, index) =>
          mkdir(
            join(
              root,
              `deep-${index.toString().padStart(2, '0')}`,
              ...Array.from({ length: 11 }, (_, level) => `level-${level}`)
            ),
            { recursive: true }
          )
        )
      )
      await mkdir(join(packageRoot, '.codex-plugin'), { recursive: true })
      await mkdir(join(packageRoot, 'skills'), { recursive: true })
      await writeFile(join(packageRoot, '.codex-plugin', 'plugin.json'), '{"skills":"./skills"}\n')
      await symlink('missing-target', candidate, 'dir')

      const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

      // Why: the depth bounds fill the issue budget first. Dropping this one for budget
      // would leave the badge amber over a candidate the dialog never mentions.
      expect(result.candidates).toEqual([{ name: 'orca-cli', path: candidate }])
      expect(result.issues).toContainEqual({
        path: candidate,
        reason: 'io-error',
        errorCode: 'ENOENT'
      })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'names the path when a dangling known-name symlink is kept as a candidate',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-plugin-declared-dangling-symlink-'))
      temporaryDirectories.push(root)
      const packageRoot = join(root, 'vendor', 'plugin')
      const candidate = join(packageRoot, 'skills', 'orca-cli')
      await mkdir(join(packageRoot, '.codex-plugin'), { recursive: true })
      await mkdir(join(packageRoot, 'skills'), { recursive: true })
      await writeFile(join(packageRoot, '.codex-plugin', 'plugin.json'), '{"skills":"./skills"}\n')
      await symlink('missing-target', candidate, 'dir')

      const result = await scanKnownPluginSkillCandidates(root, new Set(['orca-cli']))

      // Why: this candidate resolves to nothing, so it reads as inaccessible and raises
      // attention. Without the issue the dialog would report all-clear against a badge
      // that says otherwise, and nothing would ever name the broken link.
      expect(result).toEqual({
        candidates: [{ name: 'orca-cli', path: candidate }],
        issues: [{ path: candidate, reason: 'io-error', errorCode: 'ENOENT' }]
      })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not follow directory symlinks outside the plugin cache',
    async () => {
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
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not follow a SKILL.md symlink outside the plugin cache',
    async () => {
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
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not read manifest symlinks outside the plugin cache',
    async () => {
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
    }
  )

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
