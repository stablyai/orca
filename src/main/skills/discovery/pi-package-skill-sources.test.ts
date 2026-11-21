import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverPiPackageSkillSources, resolvePiAgentDir } from './pi-package-skill-sources'
import { matchesPiSkillGlob, matchesPiSkillPattern } from './pi-package-skill-glob'
import { resolvePiPackageRoot } from './pi-package-source-path'

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-pi-pkg-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('resolvePiPackageRoot', () => {
  it('rejects unsafe git and npm package specs without falling back to local paths', () => {
    const base = { piAgentDir: '/home/u/.pi/agent', homeDir: '/home/u', cwd: '/repo' }
    expect(
      resolvePiPackageRoot({ ...base, scope: 'project', source: 'git:a/../../../../tmp' })
    ).toBeNull()
    expect(
      resolvePiPackageRoot({ ...base, scope: 'user', source: 'https://github.com/only-one' })
    ).toBeNull()
    expect(resolvePiPackageRoot({ ...base, scope: 'user', source: 'npm:../evil' })).toBeNull()
    expect(resolvePiPackageRoot({ ...base, scope: 'user', source: 'npm:.' })).toBeNull()
    const expectedLocalRoot = resolve(base.homeDir, 'my-pkg')
    expect(resolvePiPackageRoot({ ...base, scope: 'user', source: '~\\my-pkg' })).toEqual({
      packageKey: `local:${process.platform === 'win32' ? expectedLocalRoot.toLowerCase() : expectedLocalRoot}`,
      packageRoot: expectedLocalRoot,
      labelName: 'my-pkg'
    })
    expect(
      resolvePiPackageRoot({ ...base, scope: 'user', source: 'npm:@scope/pkg@^1.2.0' })
    ).toEqual({
      packageKey: 'npm:@scope/pkg',
      packageRoot: resolve(base.piAgentDir, 'npm', 'node_modules', '@scope', 'pkg'),
      labelName: '@scope/pkg'
    })
  })
})

describe('discoverPiPackageSkillSources', () => {
  it('expands prefixed, multi-segment, ? and ** glob patterns in pi.skills', async () => {
    const root = await createTempDir()
    const home = join(root, 'home')
    const pkg = join(home, '.pi', 'agent', 'git', 'github.com', 'org', 'globs')
    await mkdir(join(pkg, 'skills', 'dev-a'), { recursive: true })
    await mkdir(join(pkg, 'skills', 'my-1'), { recursive: true })
    await mkdir(join(pkg, 'skills', 'nested', 'deep-skill'), { recursive: true })
    await mkdir(join(pkg, 'packages', 'sub', 'skills'), { recursive: true })
    await writeFile(
      join(pkg, 'package.json'),
      JSON.stringify({
        pi: {
          skills: ['skills/dev-*', 'skills/my-?', 'skills/**/deep-skill', 'packages/*/skills']
        }
      })
    )
    await writeFile(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ packages: ['git:github.com/org/globs'] })
    )

    const sources = await discoverPiPackageSkillSources({ homeDir: home, env: {} })
    expect(sources.map((s) => s.path).sort()).toEqual(
      [
        join(pkg, 'packages', 'sub', 'skills'),
        join(pkg, 'skills', 'dev-a'),
        join(pkg, 'skills', 'my-1'),
        join(pkg, 'skills', 'nested', 'deep-skill')
      ].sort()
    )
  })

  it('applies !path/SKILL.md and wildcard parent exclusions and ignores file symlinks', async () => {
    const root = await createTempDir()
    const home = join(root, 'home')
    const pkg = join(home, '.pi', 'agent', 'git', 'github.com', 'org', 'excl')
    await mkdir(join(pkg, 'skills', 'keep'), { recursive: true })
    await mkdir(join(pkg, 'skills', 'old'), { recursive: true })
    await mkdir(join(pkg, 'skills', 'legacy'), { recursive: true })
    await writeFile(join(pkg, 'skills', 'keep', 'SKILL.md'), '# keep')
    await writeFile(join(pkg, 'skills', 'old', 'SKILL.md'), '# old')
    await writeFile(join(pkg, 'skills', 'legacy', 'SKILL.md'), '# legacy')
    await writeFile(join(pkg, 'README.md'), 'readme')
    if (process.platform !== 'win32') {
      await symlink(join(pkg, 'README.md'), join(pkg, 'skills', 'README.md'))
    }
    await writeFile(
      join(pkg, 'package.json'),
      JSON.stringify({
        pi: { skills: ['./skills', '!./skills/old/SKILL.md', '!*/legacy'] }
      })
    )
    await writeFile(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ packages: ['git:github.com/org/excl'] })
    )

    const sources = await discoverPiPackageSkillSources({ homeDir: home, env: {} })
    expect(sources.map((s) => s.path)).toEqual([join(pkg, 'skills', 'keep')])
  })

  it('respects !, +, - operator precedence and project skills: [] overrides', async () => {
    const root = await createTempDir()
    const home = join(root, 'home')
    const cwd = join(root, 'project')
    const pkgA = join(home, '.pi', 'agent', 'git', 'github.com', 'org', 'pkg-a')
    const pkgB = join(home, '.pi', 'agent', 'git', 'github.com', 'org', 'pkg-b')
    await mkdir(join(pkgA, 'skills', 'foo'), { recursive: true })
    await mkdir(join(pkgA, 'skills', 'bar'), { recursive: true })
    await mkdir(join(pkgB, 'skills', 'baz'), { recursive: true })
    await writeFile(join(pkgA, 'skills', 'foo', 'SKILL.md'), '# foo')
    await writeFile(join(pkgA, 'skills', 'bar', 'SKILL.md'), '# bar')
    await writeFile(join(pkgB, 'skills', 'baz', 'SKILL.md'), '# baz')
    await mkdir(join(cwd, '.pi'), { recursive: true })
    await writeFile(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({
        packages: [
          {
            source: 'git:github.com/org/pkg-a',
            skills: ['!**', '+skills/foo/SKILL.md', '+skills/bar', '-skills/bar/SKILL.md']
          },
          'git:github.com/org/pkg-b'
        ]
      })
    )
    await writeFile(
      join(cwd, '.pi', 'settings.json'),
      JSON.stringify({ packages: [{ source: 'git:github.com/org/pkg-b', skills: [] }] })
    )

    const sources = await discoverPiPackageSkillSources({ homeDir: home, cwd, env: {} })
    expect(sources.map((s) => s.path)).toEqual([join(pkgA, 'skills', 'foo')])
  })

  it('supports character classes safely and finite globs deeper than 4 segments', async () => {
    expect(matchesPiSkillGlob('skills/dev-[a-b]', 'skills/dev-a')).toBe(true)
    expect(matchesPiSkillGlob('skills/foo[!x]bar', 'skills/foo/bar')).toBe(false)
    expect(matchesPiSkillGlob('skills/foo[a/b]bar', 'skills/foo/bar')).toBe(false)
    expect(matchesPiSkillGlob('skills/[z-a]', 'skills/[z-a]')).toBe(true)
    expect(matchesPiSkillGlob(`${'a*'.repeat(25)}b`, `${'a'.repeat(30)}c`)).toBe(false)
    expect(matchesPiSkillPattern('skills/group-a/my-skill', ['skills/group-*'])).toBe(true)
    expect(matchesPiSkillPattern('Skills/Group-A/my-skill', ['skills/group-a'])).toBe(true)
    expect(matchesPiSkillPattern('', ['SKILL.md'])).toBe(true)
    expect(matchesPiSkillPattern('skills/foo', ['SKILL.md'])).toBe(false)

    const root = await createTempDir()
    const home = join(root, 'home')
    const pkg = join(home, '.pi', 'agent', 'git', 'github.com', 'org', 'deep')
    const deepSkill = join(pkg, 'skills', 'a', 'b', 'c', 'd', 'e-1')
    await mkdir(deepSkill, { recursive: true })
    await writeFile(
      join(pkg, 'package.json'),
      JSON.stringify({ pi: { skills: ['skills/*/*/*/*/e-[0-9]', 'skills/[z-a]'] } })
    )
    await writeFile(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ packages: ['git:github.com/org/deep'] })
    )

    const sources = await discoverPiPackageSkillSources({ homeDir: home, env: {} })
    expect(sources.map((s) => s.path)).toEqual([deepSkill])
  })

  it('keeps manifest roots under a parent skills filter without expanding outside manifest', async () => {
    const root = await createTempDir()
    const home = join(root, 'home')
    const pkg = join(home, '.pi', 'agent', 'git', 'github.com', 'org', 'parent-filter')
    await mkdir(join(pkg, 'skills', 'foo'), { recursive: true })
    await mkdir(join(pkg, 'skills', 'bar'), { recursive: true })
    await mkdir(join(pkg, 'skills', 'outside'), { recursive: true })
    await writeFile(
      join(pkg, 'package.json'),
      JSON.stringify({ pi: { skills: ['./skills/foo', './skills/bar'] } })
    )
    await writeFile(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({
        packages: [{ source: 'git:github.com/org/parent-filter', skills: ['skills'] }]
      })
    )

    const sources = await discoverPiPackageSkillSources({ homeDir: home, env: {} })
    expect(sources.map((s) => s.path).sort()).toEqual(
      [join(pkg, 'skills', 'bar'), join(pkg, 'skills', 'foo')].sort()
    )
  })

  it('falls back to user-installed package root when project settings only filter skills', async () => {
    const root = await createTempDir()
    const home = join(root, 'home')
    const cwd = join(root, 'project')
    const pkg = join(home, '.pi', 'agent', 'git', 'github.com', 'org', 'shared')
    await mkdir(join(pkg, 'skills', 'keep'), { recursive: true })
    await mkdir(join(pkg, 'skills', 'noisy'), { recursive: true })
    await writeFile(join(pkg, 'skills', 'keep', 'SKILL.md'), '# keep')
    await writeFile(join(pkg, 'skills', 'noisy', 'SKILL.md'), '# noisy')
    await writeFile(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ packages: ['git:github.com/org/shared'] })
    )
    await mkdir(join(cwd, '.pi'), { recursive: true })
    await writeFile(
      join(cwd, '.pi', 'settings.json'),
      JSON.stringify({
        packages: [{ source: 'git:github.com/org/shared', skills: ['!skills/noisy'] }]
      })
    )

    const sources = await discoverPiPackageSkillSources({ homeDir: home, cwd, env: {} })
    expect(sources.map((s) => s.path)).toEqual([join(pkg, 'skills', 'keep')])
  })

  it('expands ~ in PI_CODING_AGENT_DIR and matches basename skill filters', async () => {
    expect(
      resolvePiAgentDir({ homeDir: '/home/u', env: { PI_CODING_AGENT_DIR: '~/.config/pi' } })
    ).toBe(resolve('/home/u', '.config', 'pi'))

    const root = await createTempDir()
    const home = join(root, 'home')
    const pkg = join(home, '.pi', 'agent', 'git', 'github.com', 'org', 'basenames')
    await mkdir(join(pkg, 'skills', 'foo'), { recursive: true })
    await mkdir(join(pkg, 'skills', 'noisy'), { recursive: true })
    await writeFile(join(pkg, 'skills', 'foo', 'SKILL.md'), '# foo')
    await writeFile(join(pkg, 'skills', 'noisy', 'SKILL.md'), '# noisy')

    await writeFile(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ packages: [{ source: 'git:github.com/org/basenames', skills: ['foo'] }] })
    )
    expect(
      (await discoverPiPackageSkillSources({ homeDir: home, env: {} })).map((s) => s.path)
    ).toEqual([join(pkg, 'skills', 'foo')])

    await writeFile(
      join(home, '.pi', 'agent', 'settings.json'),
      JSON.stringify({ packages: [{ source: 'git:github.com/org/basenames', skills: ['!noisy'] }] })
    )
    expect(
      (await discoverPiPackageSkillSources({ homeDir: home, env: {} })).map((s) => s.path)
    ).toEqual([join(pkg, 'skills', 'foo')])
  })
})
