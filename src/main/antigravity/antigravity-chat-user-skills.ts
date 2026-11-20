import {
  copyFile,
  lstat,
  mkdir,
  readlink,
  rm,
  rmdir,
  stat,
  symlink,
  unlink
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ANTIGRAVITY_ACP_HOME } from '../../shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'

// agy reads user-wide skills from these folders of its home; on Orca's chat home its app data
// folder is `antigravity-acp` where agy's own is `antigravity-cli`.
const SKILL_FOLDERS = [
  [
    ['config', 'skills'],
    ['config', 'skills']
  ],
  [
    [ANTIGRAVITY_ACP_HOME, 'skills'],
    ['antigravity-cli', 'skills']
  ]
] as const

/** The home agy resolves `~` to, where `~/.gemini` lives. */
export function antigravityUserHome(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    if (env.USERPROFILE) {
      return env.USERPROFILE
    }
    return env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : homedir()
  }
  return env.HOME || homedir()
}

// One chat home is linked by one launch at a time; another launch waits and then finds the links.
const linking = new Map<string, Promise<void>>()

/** Orca's chat home isolates its credentials; link its skill folders to `~/.gemini`'s so skills
 *  installed for Antigravity reach the chat. Never fails the launch. */
export function linkAntigravityUserSkills(
  chatHome: string,
  userHome: string,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const run = (linking.get(chatHome) ?? Promise.resolve()).then(() =>
    linkSkillFolders(chatHome, userHome, platform)
  )
  linking.set(chatHome, run)
  void run.then(() => {
    if (linking.get(chatHome) === run) {
      linking.delete(chatHome)
    }
  })
  return run
}

async function linkSkillFolders(
  chatHome: string,
  userHome: string,
  platform: NodeJS.Platform
): Promise<void> {
  for (const [linkSegments, targetSegments] of SKILL_FOLDERS) {
    const link = join(chatHome, ...linkSegments)
    const target = join(userHome, '.gemini', ...targetSegments)
    await linkSkillFolder(link, target, platform).catch((error: unknown) => {
      console.warn('[antigravity] user skills not linked into the chat home:', link, error)
    })
  }
}

async function linkSkillFolder(
  link: string,
  target: string,
  platform: NodeJS.Platform
): Promise<void> {
  const entry = await lstat(link).catch(ignoreMissing)
  // An unreadable target changes nothing; only a missing one removes the link.
  const targetExists = await stat(target).then(
    (found) => found.isDirectory(),
    (error: unknown) => ignoreMissing(error) ?? false
  )
  if (entry?.isSymbolicLink()) {
    if (targetExists && (await linksTo(link, target, platform))) {
      return
    }
    // The harness creates this folder itself, and its mkdir fails on a dangling link.
    await unlink(link)
  } else if (entry) {
    if (!targetExists || !entry.isDirectory()) {
      return
    }
    // An empty folder is the harness's placeholder; rmdir refuses one with content, which stays.
    await rmdir(link)
  }
  if (!targetExists) {
    return
  }
  await mkdir(dirname(link), { recursive: true, mode: 0o700 })
  await symlink(target, link, platform === 'win32' ? 'junction' : 'dir').catch(
    async (error: unknown) => {
      if (await linksTo(link, target, platform).catch(() => false)) {
        return
      }
      // A running chat's harness may have recreated its placeholder meanwhile.
      if ((await lstat(link)).isDirectory()) {
        await rmdir(link)
        await symlink(target, link, platform === 'win32' ? 'junction' : 'dir')
        return
      }
      throw error
    }
  )
}

async function linksTo(link: string, target: string, platform: NodeJS.Platform): Promise<boolean> {
  const linked = resolve(dirname(link), await readlink(link))
  return platform === 'win32' ? linked.toLowerCase() === target.toLowerCase() : linked === target
}

function ignoreMissing(error: unknown): undefined {
  if (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  ) {
    return undefined
  }
  throw error
}

/** agy reads user-wide rules from its home's GEMINI.md; a copy (Windows can't link files without
 *  privileges) brings `~/.gemini/GEMINI.md` to chats on Orca's home. Never fails the launch. */
export async function copyAntigravityUserRules(chatHome: string, userHome: string): Promise<void> {
  const rules = join(chatHome, 'GEMINI.md')
  const copied = await copyFile(join(userHome, '.gemini', 'GEMINI.md'), rules).then(
    () => true,
    () => false
  )
  // Rules removed from `~/.gemini` stop applying here too.
  if (!copied) {
    await rm(rules, { force: true }).catch((error: unknown) => {
      console.warn('[antigravity] stale user rules kept in the chat home:', error)
    })
  }
}
