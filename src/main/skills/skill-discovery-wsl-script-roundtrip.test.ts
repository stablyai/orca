import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { SkillScanRoot } from './skill-discovery-sources'
import { buildWslSkillDiscoveryCommand, parseWslSkillDiscoveryOutput } from './skill-discovery-wsl'

const run = promisify(execFile)

// Run the generated Bash producer through the real parser so hand-built fixtures cannot hide protocol drift. macOS lacks GNU stat -c; missing mtime is allowed here.
function root(id: string, path: string): SkillScanRoot {
  return { id, label: id, path, sourceKind: 'home', providers: ['claude'], owner: 'claude' }
}

describe.skipIf(process.platform === 'win32')('WSL skill discovery script round-trip', () => {
  it('parses back exactly what the generated script emits', async () => {
    const base = await mkdtemp(join(tmpdir(), 'orca-wsl-roundtrip-'))
    const presentRoot = join(base, 'skills')
    await mkdir(join(presentRoot, 'review'), { recursive: true })
    await writeFile(
      join(presentRoot, 'review', 'SKILL.md'),
      '---\nname: code-review\ndescription: Review code changes.\n---\n'
    )
    await mkdir(join(presentRoot, 'plan'), { recursive: true })
    await writeFile(
      join(presentRoot, 'plan', 'SKILL.md'),
      '---\nname: planner\ndescription: Plan the work.\n---\n'
    )
    const roots = [root('present', presentRoot), root('missing', join(base, 'absent'))]

    const { stdout } = await run('bash', ['-c', buildWslSkillDiscoveryCommand(roots)], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
    const result = parseWslSkillDiscoveryOutput(stdout, roots, 42)

    expect(result.skills.map((skill) => skill.name).sort()).toEqual(['code-review', 'planner'])
    expect(result.skills.map((skill) => skill.description).sort()).toEqual([
      'Plan the work.',
      'Review code changes.'
    ])
    expect(result.sources.find((source) => source.id === 'present')?.exists).toBe(true)
    expect(result.sources.find((source) => source.id === 'missing')?.exists).toBe(false)
    for (const skill of result.skills) {
      expect(skill.skillFilePath.endsWith('/SKILL.md')).toBe(true)
      expect(skill.directoryPath).toBe(skill.skillFilePath.slice(0, -'/SKILL.md'.length))
    }
    expect(result.scannedAt).toBe(42)
  })
})
