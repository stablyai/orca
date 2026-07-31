import { homedir } from 'node:os'
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Dirent } from 'node:fs'
import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { getRemoteUrl } from '../../main/git/repo'
import { parseHostedRemote } from '../../main/git/hosted-remote-url'
import { printText } from '../format'

const ORCA_SKILLS_HOME = join(homedir(), '.agents', 'skills')
const REQUIRED_ORIGIN_PATH = 'stablyai/orca'

function assertOrcaRepo(repoPath: string): void {
  const remote = getRemoteUrl(repoPath)
  if (!remote) {
    throw new RuntimeClientError('invalid_argument', `No git origin found at ${repoPath}.`)
  }
  const parsed = parseHostedRemote(remote)
  if (!parsed || parsed.path.toLowerCase() !== REQUIRED_ORIGIN_PATH) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Refusing to link: ${repoPath} origin is not ${REQUIRED_ORIGIN_PATH} (got ${parsed?.path ?? remote}).`
    )
  }
}

function eachSkillDir(repoPath: string): string[] {
  const skillsRoot = join(repoPath, 'skills')
  if (!existsSync(skillsRoot)) {
    return []
  }
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry: Dirent) => entry.isDirectory())
    .map((entry: Dirent) => entry.name)
}

function isSymlinkTo(target: string, expectedSource: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink() && readlinkSync(target) === expectedSource
  } catch {
    return false
  }
}

export const SKILLS_HANDLERS: Record<string, CommandHandler> = {
  'skills link': async ({ flags, cwd, json }) => {
    const repoPath = resolve(flags.get('repo') ? String(flags.get('repo')) : cwd)
    assertOrcaRepo(repoPath)
    const force = flags.get('force') === true
    if (!existsSync(ORCA_SKILLS_HOME)) {
      mkdirSync(ORCA_SKILLS_HOME, { recursive: true })
    }

    const linked: string[] = []
    const skipped: string[] = []
    for (const name of eachSkillDir(repoPath)) {
      const source = join(repoPath, 'skills', name)
      const target = join(ORCA_SKILLS_HOME, name)
      if (isSymlinkTo(target, source)) {
        skipped.push(name)
        continue
      }
      if (existsSync(target)) {
        if (!force) {
          throw new RuntimeClientError(
            'invalid_argument',
            `Refusing to overwrite existing ${target}. Pass --force to replace.`
          )
        }
        unlinkSync(target)
      }
      symlinkSync(source, target)
      linked.push(name)
    }
    const payload = { linked, skipped, home: ORCA_SKILLS_HOME }
    if (json) {
      printText(JSON.stringify(payload, null, 2))
    } else {
      const skipNote = skipped.length ? ` (${skipped.length} already linked, skipped)` : ''
      const msg = `Linked ${linked.length} skill(s) from ${repoPath} into ${ORCA_SKILLS_HOME}.${skipNote}`
      printText(msg)
    }
  },
  'skills unlink': async ({ flags, cwd, json }) => {
    const repoPath = resolve(flags.get('repo') ? String(flags.get('repo')) : cwd)
    assertOrcaRepo(repoPath)
    const removed: string[] = []
    for (const name of eachSkillDir(repoPath)) {
      const source = join(repoPath, 'skills', name)
      const target = join(ORCA_SKILLS_HOME, name)
      if (isSymlinkTo(target, source)) {
        unlinkSync(target)
        removed.push(name)
      }
    }
    const payload = { removed, home: ORCA_SKILLS_HOME }
    if (json) {
      printText(JSON.stringify(payload, null, 2))
    } else {
      printText(`Removed ${removed.length} symlink(s) for ${repoPath}.`)
    }
  }
}
