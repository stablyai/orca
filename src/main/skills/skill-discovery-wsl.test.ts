import { describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import type { SkillScanRoot } from './skill-discovery-sources'
import {
  buildWslSkillDiscoveryCommand,
  discoverSkillsInWsl,
  parseWslSkillDiscoveryOutput
} from './skill-discovery-wsl'

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
vi.mock('./claude-plugin-skill-sources-wsl', () => ({
  discoverClaudePluginSkillSourcesInWsl: vi.fn().mockResolvedValue([])
}))

const homeRoot: SkillScanRoot = {
  id: 'home-codex',
  label: 'Codex home',
  path: '/home/alice/.codex/skills',
  sourceKind: 'home',
  providers: ['codex'],
  owner: 'codex'
}
const repoRoot: SkillScanRoot = {
  id: 'repo-agents',
  label: 'Repo project .agents',
  path: '/work/project/.agents/skills',
  sourceKind: 'repo',
  providers: ['agent-skills'],
  owner: null
}

function record(...fields: string[]): string {
  return `${fields.join('\0')}\0`
}

describe('WSL skill discovery', () => {
  it('parses distro-native metadata and deduplicates canonical skill paths', () => {
    const markdown = Buffer.from(
      '---\nname: Review\ndescription: Review this change\n---\n',
      'utf8'
    ).toString('base64')
    const output = [
      record('R', '0', '1'),
      record('R', '1', '0'),
      record(
        'S',
        '0',
        '/home/alice/.codex/skills/.system/review/SKILL.md',
        '/opt/orca/review/SKILL.md',
        '1700000000',
        markdown
      ),
      record(
        'S',
        '1',
        '/work/project/.agents/skills/review/SKILL.md',
        '/opt/orca/review/SKILL.md',
        '1700000001',
        markdown
      )
    ].join('')

    const result = parseWslSkillDiscoveryOutput(output, [homeRoot, repoRoot], 42)

    expect(result.scannedAt).toBe(42)
    expect(result.skills).toEqual([
      expect.objectContaining({
        name: 'Review',
        description: 'Review this change',
        sourceKind: 'bundled',
        rootPath: homeRoot.path,
        skillFilePath: '/home/alice/.codex/skills/.system/review/SKILL.md',
        updatedAt: 1_700_000_000_000
      })
    ])
    expect(result.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'home-codex', exists: true }),
        expect.objectContaining({ id: 'repo-agents', exists: false, skippedReason: 'missing' })
      ])
    )
  })

  it('builds a distro-side scan for enumeration, reads, and canonical identity', () => {
    const command = buildWslSkillDiscoveryCommand([
      { ...repoRoot, path: "/work/alice's project/.agents/skills" }
    ])
    const encoded = /printf %s '([^']+)'/.exec(command)?.[1]
    expect(encoded).toBeTruthy()
    const script = Buffer.from(encoded!, 'base64').toString('utf8')

    expect(script).toContain('find -L "$root_path"')
    expect(script).toContain('realpath -- "$skill_file"')
    expect(script).toContain('head -c 262144 -- "$skill_file"')
    expect(script).toContain(`'/work/alice'\\''s project/.agents/skills'`)
  })

  it('rejects malformed host responses instead of reporting an empty scan', () => {
    expect(() => parseWslSkillDiscoveryOutput(record('S', '9'), [homeRoot])).toThrow(
      'unknown source'
    )
  })

  it('reports a clear timeout error instead of the raw execFile "Command failed" message', async () => {
    const mockedExecFile = vi.mocked(execFile)
    mockedExecFile.mockImplementation((..._args: unknown[]) => {
      const callback = _args.at(-1) as (error: NodeJS.ErrnoException) => void
      const error = new Error(
        'Command failed: wsl.exe -d Ubuntu -- bash -c ...'
      ) as NodeJS.ErrnoException & {
        killed?: boolean
        signal?: string
      }
      error.killed = true
      error.signal = 'SIGTERM'
      callback(error)
      return {} as ReturnType<typeof execFile>
    })

    await expect(
      discoverSkillsInWsl({ distro: 'Ubuntu', homeDir: '/home/alice', cwd: '/home/alice' })
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.stringMatching(
          /^(?=.*timed out after 60s)(?=.*Ubuntu)(?!.*Command failed).*$/s
        )
      })
    )
  })

  it('passes the whole encoded script to wsl.exe as a single argv element', async () => {
    const mockedExecFile = vi.mocked(execFile)
    let capturedArgs: unknown[] = []
    mockedExecFile.mockImplementation((..._args: unknown[]) => {
      capturedArgs = _args[1] as unknown[]
      const callback = _args.at(-1) as (error: null, stdout: string) => void
      callback(null, record('R', '0', '0'))
      return {} as ReturnType<typeof execFile>
    })

    await discoverSkillsInWsl({ distro: 'Ubuntu', homeDir: '/home/alice', cwd: '/home/alice' })

    expect(capturedArgs).toHaveLength(6)
    expect(capturedArgs.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--', 'bash', '-c'])
    const scriptArg = capturedArgs[5]
    // The whole wrapper (control statement + Base64 payload) must arrive as
    // one argv element — execFile never hands this to an intermediate shell
    // that could re-split it on the `;` inside `set -o pipefail;`.
    expect(typeof scriptArg).toBe('string')
    expect((scriptArg as string).startsWith('set -o pipefail; printf %s ')).toBe(true)
  })
})
