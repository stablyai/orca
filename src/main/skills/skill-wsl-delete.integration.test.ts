import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { resolveWslExecutablePath } from '../wsl/wsl-executable-path'
import { WslSkillInstallFilesystem } from './skill-wsl-install-filesystem'

const DISTRO = process.env.ORCA_REAL_WSL_SKILL_DISTRO ?? 'Ubuntu-24.04'
const RUN_REAL_WSL = process.platform === 'win32' && process.env.ORCA_REAL_WSL_SKILL_TEST === '1'

async function runWsl(...args: string[]): Promise<string> {
  const result = await runProcess({
    program: resolveWslExecutablePath(),
    args: ['-d', DISTRO, '--exec', ...args],
    timeoutMs: 30_000
  })
  // `runProcess` reports a non-zero exit as data; this harness wants it fatal.
  if (result.code !== 0) {
    throw new Error(`wsl ${args.join(' ')} exited ${result.code}: ${result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

function uncPath(guestPath: string): string {
  return `\\\\wsl.localhost\\${DISTRO}${guestPath.replaceAll('/', '\\')}`
}

/**
 * Enumeration and deletion stay server-side in the distro for the same reason
 * install does: node's `fs` over a `\\wsl$` path applies Windows semantics to
 * POSIX symlinks and permissions.
 */
describe.runIf(RUN_REAL_WSL)('real WSL skill deletion primitives', () => {
  let guestRoot = ''
  let skillsRoot = ''

  beforeAll(async () => {
    guestRoot = await runWsl('mktemp', '-d', '/tmp/orca-skill-delete.XXXXXX')
    if (!guestRoot.startsWith('/tmp/orca-skill-delete.')) {
      throw new Error('unexpected-wsl-integration-root')
    }
    skillsRoot = `${guestRoot}/home/.agents/skills`
    await runWsl('mkdir', '-p', `${skillsRoot}/demo`, `${guestRoot}/home/.codex/skills/demo`)
    await runWsl('sh', '-c', `printf '%s' 'x' > ${skillsRoot}/demo/SKILL.md`)
    // An alias-dir in another provider root, and an alias-file inside a real one.
    await runWsl('mkdir', '-p', `${guestRoot}/home/.claude/skills`)
    await runWsl('ln', '-sT', `${skillsRoot}/demo`, `${guestRoot}/home/.claude/skills/demo`)
    await runWsl(
      'ln',
      '-sT',
      `${skillsRoot}/demo/SKILL.md`,
      `${guestRoot}/home/.codex/skills/demo/SKILL.md`
    )
    // Deliberately differs only by case, to prove POSIX case-sensitivity.
    await runWsl('mkdir', '-p', `${guestRoot}/home/.agents/Skills`)
  })

  afterAll(async () => {
    if (guestRoot.startsWith('/tmp/orca-skill-delete.')) {
      await runWsl('rm', '-rf', '--', guestRoot)
    }
  })

  it('refuses an unauthorized root before authorizeRoots, and permits it after', async () => {
    const filesystem = new WslSkillInstallFilesystem(DISTRO, [])
    await expect(filesystem.listEntries([uncPath(skillsRoot)])).rejects.toThrow(
      'skill-install-wsl-path-outside-root'
    )
    filesystem.authorizeRoots([uncPath(skillsRoot)])
    const listing = await filesystem.listEntries([uncPath(skillsRoot)])
    expect(listing.get(uncPath(skillsRoot))).toContainEqual({ name: 'demo', kind: 'directory' })
  })

  it('keeps containment case-sensitive, as the guest filesystem is', async () => {
    const filesystem = new WslSkillInstallFilesystem(DISTRO, [
      uncPath(`${guestRoot}/home/.agents/Skills`)
    ])
    await expect(filesystem.remove(uncPath(`${skillsRoot}/demo`))).rejects.toThrow(
      'skill-install-wsl-path-outside-root'
    )
  })

  it('classifies alias-dir and alias-file from one batched inspection', async () => {
    const filesystem = new WslSkillInstallFilesystem(DISTRO, [uncPath(`${guestRoot}/home`)])
    const aliasDir = uncPath(`${guestRoot}/home/.claude/skills/demo`)
    const aliasFile = uncPath(`${guestRoot}/home/.codex/skills/demo/SKILL.md`)
    const canonicalFile = uncPath(`${skillsRoot}/demo/SKILL.md`)
    const inspections = await filesystem.inspectPaths([aliasDir, aliasFile, canonicalFile])

    expect(inspections.get(aliasDir)).toMatchObject({
      kind: 'symlink',
      realpath: `${skillsRoot}/demo`
    })
    expect(inspections.get(aliasFile)).toMatchObject({
      kind: 'symlink',
      realpath: `${skillsRoot}/demo/SKILL.md`
    })
    expect(inspections.get(canonicalFile)).toMatchObject({
      kind: 'file',
      realpath: `${skillsRoot}/demo/SKILL.md`
    })
  })

  it('reads mtime without dereferencing, so an alias-file records the link itself', async () => {
    const filesystem = new WslSkillInstallFilesystem(DISTRO, [uncPath(`${guestRoot}/home`)])
    const aliasFile = uncPath(`${guestRoot}/home/.codex/skills/demo/SKILL.md`)
    const inspection = (await filesystem.inspectPaths([aliasFile])).get(aliasFile)
    const linkSeconds = Number.parseInt(
      await runWsl('stat', '-c', '%Y', '--', `${guestRoot}/home/.codex/skills/demo/SKILL.md`),
      10
    )
    expect(inspection?.mtimeMs).toBe(linkSeconds * 1000)
  })

  it('renames a placement to a hidden sibling and removes it', async () => {
    const filesystem = new WslSkillInstallFilesystem(DISTRO, [uncPath(`${guestRoot}/home`)])
    const source = `${skillsRoot}/demo`
    const staged = `${skillsRoot}/.demo.orca-skill-delete-integration`
    await filesystem.rename(uncPath(source), uncPath(staged))
    expect(await runWsl('sh', '-c', `[ -d '${staged}' ] && printf yes`)).toBe('yes')
    await filesystem.remove(uncPath(staged))
    expect(await runWsl('sh', '-c', `[ -e '${staged}' ] || printf gone`)).toBe('gone')
  })
})
