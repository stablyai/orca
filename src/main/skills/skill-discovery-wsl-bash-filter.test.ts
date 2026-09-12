import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildWslSkillDiscoveryCommand, parseWslSkillDiscoveryOutput } from './skill-discovery-wsl'
import type { SkillScanRoot } from './skill-discovery-sources'

async function writeSkill(root: string, directory: string, markdown: string): Promise<void> {
  const skillDirectory = join(root, directory)
  await mkdir(skillDirectory, { recursive: true })
  await writeFile(join(skillDirectory, 'SKILL.md'), markdown)
}

describe('generated WSL skill name filter', () => {
  it.skipIf(process.platform !== 'linux')(
    'rejects only known scalar mismatches and passes uncertain names to TypeScript',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-wsl-name-filter-'))
      const scanRoot: SkillScanRoot = {
        id: 'home',
        owner: 'agents',
        path: root,
        label: 'Home',
        sourceKind: 'home',
        providers: ['agent-skills']
      }
      await writeSkill(root, 'scalar-match', '---\nname: orchestration\n---\n')
      await writeSkill(root, 'scalar-mismatch', '---\nname: unrelated\n---\n')
      await writeSkill(root, 'empty-quoted', '---\nname: ""\n---\n# orchestration\n')
      await writeSkill(root, 'one-quote', '---\nname: "\n---\n# orchestration\n')
      await writeSkill(root, 'block-name', '---\nname: >-\n  orchestration\n---\n')
      await writeSkill(root, 'bom-crlf', "\uFEFF---\r\nname: 'orchestration'\r\n---\r\n")
      await writeSkill(root, 'unicode-space', '---\nname:\u3000orchestration\n---\n')
      await writeSkill(root, 'missing-close', '---\nname: unrelated\n# orchestration\n')
      await writeSkill(root, 'duplicate-match', '---\nname: unrelated\nname: orchestration\n---\n')
      await writeSkill(
        root,
        'duplicate-mismatch',
        '---\nname: orchestration\nname: unrelated\n---\n'
      )
      await writeSkill(
        root,
        'beyond-limit',
        `---\ndescription: |\n${'  x\n'.repeat(70_000)}name: unrelated\n---\n# orchestration\n`
      )
      await writeSkill(
        root,
        'multibyte-beyond-limit',
        `---\ndescription: ${'한'.repeat(90_000)}\nname: unrelated\n---\n# orchestration\n`
      )

      try {
        const command = buildWslSkillDiscoveryCommand([scanRoot], ['orchestration'])
        const output = execFileSync('/bin/bash', ['-c', command], {
          encoding: 'utf8',
          maxBuffer: 4 * 1024 * 1024
        })
        expect(output).not.toContain('scalar-mismatch')
        expect(output).not.toContain('duplicate-mismatch')
        expect(output).toContain('beyond-limit')
        expect(output).toContain('multibyte-beyond-limit')
        expect(
          parseWslSkillDiscoveryOutput(output, [scanRoot], 42, ['home'], ['orchestration'])
            .skills.map((skill) => skill.directoryPath.split('/').at(-1))
            .sort()
        ).toEqual([
          'block-name',
          'bom-crlf',
          'duplicate-match',
          'empty-quoted',
          'missing-close',
          'one-quote',
          'scalar-match',
          'unicode-space'
        ])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    30_000
  )
})
