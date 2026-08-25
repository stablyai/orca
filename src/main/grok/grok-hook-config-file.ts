import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { parseHooksJsonText } from '../agent-hooks/hooks-json-read'
import type { HooksConfig } from '../agent-hooks/installer-utils'

const WINDOWS_RENAME_ATTEMPTS = 6

export type AsyncGrokHookConfigSnapshot = {
  raw: string | null
  config: HooksConfig | null
}

export async function readGrokHookConfigSnapshot(
  targetPath: string
): Promise<AsyncGrokHookConfigSnapshot> {
  const raw = await readFileOrNull(targetPath)
  return raw === null ? { raw: null, config: {} } : { raw, config: parseHooksJsonText(raw) }
}

// Why temp+rename and not the guarded hard-link swap in codex-accounts/fs-utils: Grok stats every
// global hook JSON and refuses to build a sandbox profile for one with st_nlink != 1, so a file
// briefly carrying a second link fails any Grok session that starts in that window. rename() never
// creates a second link. The compare-and-swap below is therefore read-compare-rename; the residual
// window is one atomic rename rather than the whole publish.
export async function writeGrokHookConfigIfUnchanged(
  targetPath: string,
  expectedContents: string,
  contents: string
): Promise<boolean> {
  if ((await readFileOrNull(targetPath)) !== expectedContents) {
    return false
  }
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(tempPath, contents, 'utf8')
    await renameWithWindowsRetry(tempPath, targetPath)
    return true
  } catch (error) {
    await rm(tempPath, { force: true })
    throw error
  }
}

export async function removeGrokHookConfigIfUnchanged(
  targetPath: string,
  expectedContents: string
): Promise<boolean> {
  if ((await readFileOrNull(targetPath)) !== expectedContents) {
    return false
  }
  await rm(targetPath, { force: true })
  return true
}

async function readFileOrNull(targetPath: string): Promise<string | null> {
  try {
    return await readFile(targetPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

// Why: on Windows an antivirus scan or another agent CLI can hold the target open briefly.
async function renameWithWindowsRetry(sourcePath: string, targetPath: string): Promise<void> {
  const attempts = process.platform === 'win32' ? WINDOWS_RENAME_ATTEMPTS : 1
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rename(sourcePath, targetPath)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt < attempts && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 50))
        continue
      }
      throw error
    }
  }
}
