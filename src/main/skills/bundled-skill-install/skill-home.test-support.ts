import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import type { BundledSkillPlan } from '../../../shared/bundled-skill-plan'
import type { SkillInstallProviderId } from '../../../shared/skill-install-providers'
import type { BundledSkillSource } from './bundled-skill-sources'
import type { BundledSkillFilesystem } from './filesystem'
import {
  installBundledSkills,
  previewBundledSkillInstall,
  type BundledSkillServiceInput
} from './service'

export const NAME = 'test-skill'
export const OLD_TEXT = `---\nname: ${NAME}\ndescription: Old\n---\n\nOld body\n`
export const NEW_TEXT = `---\nname: ${NAME}\ndescription: New\n---\n\nNew body\n`
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
export const NEW_SOURCE: BundledSkillSource = {
  name: NAME,
  text: NEW_TEXT,
  releasedDigests: [digest(OLD_TEXT), digest(NEW_TEXT)]
}
export const NPX_LOCK = JSON.stringify({
  version: 3,
  skills: { [NAME]: { source: 'stablyai/orca', skillFolderHash: 'b59f2737' } }
})

export type SkillHome = {
  root: string
  home: string
  shared: string
  claude: string
  cursor: string
  state: string
  lock: string
}

const directories: string[] = []

export async function makeSkillHome(): Promise<SkillHome> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-bundled-skill-')))
  directories.push(root)
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  return {
    root,
    home,
    shared: join(home, '.agents', 'skills', NAME),
    claude: join(home, '.claude', 'skills', NAME),
    cursor: join(home, '.cursor', 'skills', NAME),
    state: join(root, 'state'),
    lock: join(home, '.agents', '.skill-lock.json')
  }
}

export async function removeSkillHomes(): Promise<void> {
  for (const directory of directories.splice(0)) {
    // Restore permissions changed by read-only fixtures before cleanup.
    await chmod(join(directory, 'home', '.agents', 'skills'), 0o755).catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
}

/** Directory links as the product makes them: junctions on Windows need no Developer Mode. */
export async function linkDirectory(target: string, path: string): Promise<void> {
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

export async function writeCopy(path: string, text: string, extra: Record<string, string> = {}) {
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'SKILL.md'), text)
  for (const [name, body] of Object.entries(extra)) {
    await writeFile(join(path, name), body)
  }
}

export async function writeNpxLock(home: SkillHome): Promise<void> {
  await mkdir(join(home.home, '.agents'), { recursive: true })
  await writeFile(home.lock, NPX_LOCK)
}

export function serviceInput(
  home: SkillHome,
  options: {
    agents?: SkillInstallProviderId[]
    force?: string[]
    installedOnly?: boolean
    filesystem?: BundledSkillFilesystem
    workspaceDirectory?: string
    providerRootOverrides?: BundledSkillServiceInput['providerRootOverrides']
  } = {}
): BundledSkillServiceInput {
  return {
    destination: options.workspaceDirectory
      ? {
          scope: 'workspace',
          homeDirectory: home.home,
          workspaceDirectory: options.workspaceDirectory
        }
      : { scope: 'global', homeDirectory: home.home },
    agents: options.agents ?? ['claude'],
    stateDirectory: home.state,
    sources: [NEW_SOURCE],
    lockTimeoutMs: 200,
    ...(options.force ? { force: options.force } : {}),
    ...(options.installedOnly ? { installedOnly: true } : {}),
    ...(options.filesystem ? { filesystem: options.filesystem } : {}),
    ...(options.providerRootOverrides
      ? { providerRootOverrides: options.providerRootOverrides }
      : {})
  }
}

export async function snapshot(path: string): Promise<string> {
  const stat = await lstat(path).catch(() => null)
  if (!stat) {
    return 'missing'
  }
  if (stat.isSymbolicLink()) {
    return `link:${await readlink(path)}`
  }
  if (!stat.isDirectory()) {
    return `file:${await readFile(path, 'utf8')}`
  }
  const entries = (await readdir(path)).sort().join(',')
  return `dir[${entries}]:${await readFile(join(path, 'SKILL.md'), 'utf8').catch(() => '?')}`
}

export async function leftoverSiblings(path: string): Promise<string[]> {
  const parent = join(path, '..')
  return (await readdir(parent).catch(() => [])).filter((name) =>
    /\.orca-(?:stage|old)-/u.test(name)
  )
}

export async function previewAndInstall(input: BundledSkillServiceInput) {
  const plan = await previewBundledSkillInstall(input)
  const result = await installBundledSkills(input, plan.planDigest)
  expect(result.skills.map((skill) => skill.status)).toEqual(plan.skills.map(() => 'ran'))
  expect(
    result.skills.map((skill) => skill.ops.map((op) => [op.path, op.kind, op.status]))
  ).toEqual(plan.skills.map((skill) => skill.ops.map((op) => [op.path, op.kind, 'done'])))
  return { plan, result }
}

export function opsOf(plan: BundledSkillPlan) {
  return plan.skills[0].ops.map((op) => [op.path, op.kind, op.reason])
}
