import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { quotePosixShellUnlessPlain } from '../../shared/shell/launch/shell-argument-quoting'
import { writePluginFileAtomically } from '../plugins/installation/plugin-atomic-file-write'

const SCRIPT_FILE_NAME = 'antigravity-statusline.sh'
const RECORD_FILE_NAME = 'antigravity-statusline.json'

export type AntigravityStatusLineOptions = { homeDir?: string }

export type Paths = { settings: string; script: string; record: string; installedCommand: string }

/** Everything a removal needs to give the slot back as the user had it. */
export type InstallRecord = {
  /** Null when the slot was empty or held a blank command. */
  originalCommand: string | null
  /** The command's JSON literal as the file spelled it; absent when no statusLine key existed. */
  originalCommandLiteral?: string
  installedCommand: string
  /** The whole settings file before install (null: Orca created it) and a hash of what Orca wrote. */
  preInstallText: string | null
  postInstallSha256: string
}

export function resolvePaths(options: AntigravityStatusLineOptions): Paths {
  const home = options.homeDir ?? homedir()
  const script = join(home, '.orca', 'agent-hooks', SCRIPT_FILE_NAME)
  return {
    settings: join(home, '.gemini', 'antigravity-cli', 'settings.json'),
    script,
    record: join(home, '.orca', 'agent-hooks', RECORD_FILE_NAME),
    installedCommand: quotePosixShellUnlessPlain(script)
  }
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** Follows a symlinked settings.json so edits replace its target, not the link. */
export async function resolveSettingsTarget(
  path: string
): Promise<{ target: string } | { error: string }> {
  try {
    return { target: await realpath(path) }
  } catch (error) {
    if (!isMissing(error)) {
      return { error: 'Could not read Antigravity settings.json' }
    }
  }
  const link = await lstat(path).then(
    (info) => info.isSymbolicLink(),
    () => false
  )
  return link
    ? { error: 'Antigravity settings.json is a broken link; left unchanged' }
    : { target: path }
}

export async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) {
      return null
    }
    throw error
  }
}

/**
 * Replaces (or, with `next` null, deletes) the settings file only if it still holds `expected`.
 * The temp file is ready before the final read, so the unguarded window is that read plus the
 * rename. Another writer that saves inside it is still overwritten; Orca cannot lock agy's file.
 * An existing file keeps its mode; one Orca creates is private.
 */
export async function commitSettingsText(
  target: string,
  expected: string | null,
  next: string | null
): Promise<boolean> {
  if (next === null) {
    if ((await readTextOrNull(target)) !== expected) {
      return false
    }
    await rm(target, { force: true })
    return true
  }
  const mode = await stat(target).then(
    (info) => info.mode & 0o777,
    () => 0o600
  )
  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, next, { encoding: 'utf8', mode })
    await chmod(temporary, mode)
    const current = await readTextOrNull(target)
    if (current !== expected) {
      await rm(temporary, { force: true })
      return false
    }
    await rename(temporary, target)
    return true
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Puts a private file back to the bytes it held (null: it did not exist). */
export async function restoreFileText(
  path: string,
  text: string | null,
  mode: number
): Promise<void> {
  if (text === null) {
    await rm(path, { force: true })
  } else {
    await mkdir(dirname(path), { recursive: true })
    await writePluginFileAtomically(path, text, { mode })
  }
}

export async function readRecord(path: string): Promise<InstallRecord | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (
      typeof raw === 'object' &&
      raw !== null &&
      'installedCommand' in raw &&
      typeof raw.installedCommand === 'string' &&
      'originalCommand' in raw &&
      (raw.originalCommand === null || typeof raw.originalCommand === 'string') &&
      'postInstallSha256' in raw &&
      typeof raw.postInstallSha256 === 'string' &&
      'preInstallText' in raw &&
      (raw.preInstallText === null || typeof raw.preInstallText === 'string')
    ) {
      return {
        originalCommand: raw.originalCommand,
        ...('originalCommandLiteral' in raw && typeof raw.originalCommandLiteral === 'string'
          ? { originalCommandLiteral: raw.originalCommandLiteral }
          : {}),
        installedCommand: raw.installedCommand,
        preInstallText: raw.preInstallText,
        postInstallSha256: raw.postInstallSha256
      }
    }
  } catch {
    // A missing or damaged record means no restore point.
  }
  return null
}

// The record and script hold the user's command, so only the owner may read them.
export async function writeRecord(path: string, record: InstallRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writePluginFileAtomically(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
}

export async function writeScript(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writePluginFileAtomically(path, content, { mode: 0o700 })
}

export async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}
