import { lstat, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { DRAG_TEMP_COPY_DIR_PATTERN } from './dragged-temp-file-copy'
import { sweepExpiredOwnedDirectories } from './owned-temp-staging-root'

// Images pasted or dropped (macOS drag copies) into a chat live here rather than in OS temp, so
// a draft restored after a reboot still names a real file. One directory per image, swept by age.
const ATTACHMENT_ROOT_NAME = 'native-chat-attachments'
const ATTACHMENT_DIR_PREFIX = 'chat-image-'
const ATTACHMENT_DIR_PATTERN = /^chat-image-[A-Za-z0-9]{6}$/
// Why: an unsent draft can wait weeks; past this its chip shows as missing and blocks Send.
export const NATIVE_CHAT_ATTACHMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000
const SWEEP_FIRST_DELAY_MS = 30 * 1000
const SWEEP_INTERVAL_MS = 60 * 60 * 1000

export function getNativeChatAttachmentRoot(): string {
  return join(getAppEnvironment().getPath('userData'), ATTACHMENT_ROOT_NAME)
}

/** Writes one chat attachment under Orca's own storage and returns its path. */
export async function saveNativeChatAttachmentFile(
  fileName: string,
  contents: Buffer
): Promise<string> {
  const root = getNativeChatAttachmentRoot()
  if (!(await ensureNativeChatAttachmentRoot(root))) {
    throw new Error('Chat attachment storage is not a directory')
  }
  const filePath = join(await mkdtemp(join(root, ATTACHMENT_DIR_PREFIX)), fileName)
  await writeFile(filePath, contents)
  return filePath
}

/** The attachment root as a filesystem root, so a restored draft's previews still resolve. */
export function getNativeChatAttachmentAllowedRoots(): string[] {
  return hasAppEnvironment() ? [resolve(getNativeChatAttachmentRoot())] : []
}

/**
 * The one rule for this folder, for pastes and composer drops alike: Orca creates it owner-only,
 * and an existing one only has to be a real directory, not a symlink.
 */
export async function ensureNativeChatAttachmentRoot(
  root = getNativeChatAttachmentRoot()
): Promise<boolean> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  return isRealDirectory(root)
}

// Why not the shared-temp ownership check: user data is already per user, and its modes may not
// survive a restore or a filesystem without them.
async function isRealDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch {
    return false
  }
}

export async function sweepExpiredNativeChatAttachments(nowMs = Date.now()): Promise<void> {
  const root = getNativeChatAttachmentRoot()
  if (!(await isRealDirectory(root))) {
    return
  }
  await sweepExpiredOwnedDirectories(root, {
    nowMs,
    ttlMs: NATIVE_CHAT_ATTACHMENT_TTL_MS,
    ownsEntry: (name) => ATTACHMENT_DIR_PATTERN.test(name) || DRAG_TEMP_COPY_DIR_PATTERN.test(name)
  })
}

let sweepScheduled = false

/** Sweep shortly after startup, then hourly, so a long-running app still expires attachments. */
export function scheduleNativeChatAttachmentSweep(): void {
  if (sweepScheduled) {
    return
  }
  sweepScheduled = true
  const sweep = (): void => {
    void sweepExpiredNativeChatAttachments().catch(() => undefined)
  }
  setTimeout(sweep, SWEEP_FIRST_DELAY_MS).unref()
  setInterval(sweep, SWEEP_INTERVAL_MS).unref()
}
