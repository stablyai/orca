// The one line Orca may add to ~/.ssh/config, and only when the user agrees: editors' Remote-SSH
// resolves a host alias from that file (VS Code's `remote.SSH.configFile` would replace it
// instead). `Include` must come before any `Host` block or it would apply only inside that block,
// so it goes first, marked so it can be found and removed exactly.
import {
  chmod,
  copyFile,
  constants,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile
} from 'node:fs/promises'
import { dirname } from 'node:path'

export const CLOUD_SSH_INCLUDE_MARKER = '# Added by Orca: Orca Cloud workspaces (orca ssh)'

export function cloudSshIncludeLine(configFile: string): string {
  return `Include "${configFile}"`
}

export function hasCloudSshInclude(content: string, configFile: string): boolean {
  return content.split(/\r?\n/).some((line) => line.trim() === cloudSshIncludeLine(configFile))
}

/** The file with Orca's Include first; unchanged when it is already there. */
export function withCloudSshInclude(content: string, configFile: string): string {
  if (hasCloudSshInclude(content, configFile)) {
    return content
  }
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const block = `${CLOUD_SSH_INCLUDE_MARKER}${eol}${cloudSshIncludeLine(configFile)}${eol}`
  return content.length === 0 ? block : `${block}${eol}${content}`
}

/** The file without Orca's Include (and its marker); other lines are kept byte for byte. */
export function withoutCloudSshInclude(content: string, configFile: string): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const lines = content.split(/\r?\n/)
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line === cloudSshIncludeLine(configFile)) {
      // Drop the blank separator this module added after the block.
      if (lines[i + 1] === '' && i + 2 < lines.length) {
        i++
      }
      continue
    }
    if (
      line === CLOUD_SSH_INCLUDE_MARKER &&
      lines[i + 1]?.trim() === cloudSshIncludeLine(configFile)
    ) {
      continue
    }
    kept.push(lines[i]!)
  }
  return kept.join(eol)
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return ''
    }
    throw error
  }
}

/** Writes through a temp file so a crash never leaves a half-written ~/.ssh/config. A symlinked
 *  config (dotfile managers) is updated at its target, keeping the link and the file's mode. */
async function replaceFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const target = await realpath(path).catch(() => path)
  const mode = await stat(target).then(
    (info) => info.mode & 0o777,
    () => 0o600
  )
  const temp = `${target}.orca-${process.pid}.tmp`
  await writeFile(temp, content, { mode })
  await rename(temp, target)
  await chmod(target, mode).catch(() => {})
}

export async function readCloudSshIncludeState(
  userSshConfig: string,
  configFile: string
): Promise<boolean> {
  return hasCloudSshInclude(await readOptional(userSshConfig), configFile)
}

export async function addCloudSshInclude(userSshConfig: string, configFile: string): Promise<void> {
  const before = await readOptional(userSshConfig)
  const after = withCloudSshInclude(before, configFile)
  if (after !== before) {
    if (before) {
      // One untouched copy from before Orca's first edit; never overwritten afterwards.
      const target = await realpath(userSshConfig).catch(() => userSshConfig)
      await copyFile(target, `${target}.orca-backup`, constants.COPYFILE_EXCL).catch(() => {})
    }
    await replaceFile(userSshConfig, after)
  }
}

export async function removeCloudSshInclude(
  userSshConfig: string,
  configFile: string
): Promise<void> {
  const before = await readOptional(userSshConfig)
  const after = withoutCloudSshInclude(before, configFile)
  if (after !== before) {
    await replaceFile(userSshConfig, after)
  }
}
