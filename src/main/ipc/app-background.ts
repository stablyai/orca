import { BrowserWindow, dialog, ipcMain } from 'electron'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { extname, join } from 'node:path'
import { z } from 'zod'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  APP_BACKGROUND_IMAGE_EXTENSIONS,
  MAX_APP_BACKGROUND_IMAGE_BYTES,
  getAppBackgroundImageMimeType,
  isAppBackgroundImageId
} from '../../shared/app-background-settings'
import type {
  AppBackgroundCommitResult,
  AppBackgroundPickResult
} from '../../shared/app-background-types'
import { detectImageFileSignature } from '../image-file-signature'
import { translateMain } from '../i18n/main-i18n'
import { isENOENT } from './filesystem-path-containment'
import {
  getAppBackgroundDir,
  getAppBackgroundStagingDir,
  resolveAppBackgroundImageFile
} from './app-background-storage-paths'

// Why structural: tests drive the handlers with a two-method fake instead of a full Store.
type AppBackgroundSettingsStore = {
  getSettings: () => Pick<GlobalSettings, 'appBackgroundImageId'>
  updateSettingsAndFlush: (
    updates: Partial<GlobalSettings>,
    options: { notifyListeners: boolean }
  ) => Promise<unknown>
}

const ReadArgsSchema = z.object({ id: z.string(), staging: z.boolean().optional() })
const CommitArgsSchema = z.object({ stagingId: z.string().nullable() })

// Why: the deferred startup sweep must not delete an image the user picked in this session.
const stagedThisSession = new Set<string>()
let commitQueue: Promise<unknown> = Promise.resolve()

export async function stageAppBackgroundImage(
  sourcePath: string
): Promise<AppBackgroundPickResult> {
  const ext = extname(sourcePath).slice(1).toLowerCase()
  const expectedMime = ext ? getAppBackgroundImageMimeType(ext) : null
  if (!expectedMime) {
    return { status: 'rejected', reason: 'unsupportedType' }
  }
  let bytes: Buffer
  try {
    const sourceStat = await stat(sourcePath)
    if (!sourceStat.isFile()) {
      return { status: 'rejected', reason: 'unreadable' }
    }
    if (sourceStat.size > MAX_APP_BACKGROUND_IMAGE_BYTES) {
      return { status: 'rejected', reason: 'tooLarge' }
    }
    bytes = await readFile(sourcePath)
  } catch {
    return { status: 'rejected', reason: 'unreadable' }
  }
  // Why: validate and stage the same bytes, so a file swapped after stat cannot slip through.
  if (bytes.byteLength > MAX_APP_BACKGROUND_IMAGE_BYTES) {
    return { status: 'rejected', reason: 'tooLarge' }
  }
  if (detectImageFileSignature(bytes)?.mimeType !== expectedMime) {
    return { status: 'rejected', reason: 'unsupportedType' }
  }
  const stagingId = `${randomUUID()}.${ext}`
  const dest = join(getAppBackgroundStagingDir(), stagingId)
  try {
    await mkdir(getAppBackgroundStagingDir(), { recursive: true })
    await writeFile(dest, bytes)
  } catch {
    await rm(dest, { force: true }).catch(() => {})
    return { status: 'rejected', reason: 'saveFailed' }
  }
  stagedThisSession.add(stagingId)
  return { status: 'picked', stagingId }
}

async function commitAppBackgroundImage(
  store: AppBackgroundSettingsStore,
  stagingId: string | null
): Promise<AppBackgroundCommitResult> {
  if (stagingId !== null) {
    const source = resolveAppBackgroundImageFile(stagingId, true)
    const dest = resolveAppBackgroundImageFile(stagingId, false)
    if (!source || !dest) {
      return { ok: false, reason: 'invalidId' }
    }
    try {
      await rename(source, dest)
    } catch (error) {
      return { ok: false, reason: isENOENT(error) ? 'stagingMissing' : 'saveFailed' }
    }
    stagedThisSession.delete(stagingId)
  }
  const previousId = store.getSettings().appBackgroundImageId ?? null
  // Why flush before deleting the old file: a crash in between must not leave settings naming a missing image.
  try {
    await store.updateSettingsAndFlush(
      { appBackgroundImageId: stagingId },
      { notifyListeners: true }
    )
  } catch (error) {
    console.warn('[app-background] failed to save the background setting', error)
    if (stagingId !== null) {
      await restoreUncommittedImage(stagingId)
    }
    return { ok: false, reason: 'saveFailed' }
  }
  if (previousId !== null && previousId !== stagingId) {
    const previousFile = resolveAppBackgroundImageFile(previousId, false)
    if (previousFile) {
      await rm(previousFile, { force: true }).catch((error) => {
        console.warn('[app-background] failed to remove the previous image', error)
      })
    }
  }
  return { ok: true, imageId: stagingId }
}

// Why back to staging: the draft still names this id, so the user can retry without re-picking.
async function restoreUncommittedImage(stagingId: string): Promise<void> {
  const committed = resolveAppBackgroundImageFile(stagingId, false)
  const staged = resolveAppBackgroundImageFile(stagingId, true)
  if (!committed || !staged) {
    return
  }
  try {
    await rename(committed, staged)
    stagedThisSession.add(stagingId)
  } catch (error) {
    console.warn('[app-background] failed to restore an unsaved image to staging', error)
    await rm(committed, { force: true }).catch(() => {})
  }
}

async function discardAppBackgroundStaging(stagingId: string): Promise<void> {
  const filePath = resolveAppBackgroundImageFile(stagingId, true)
  if (!filePath) {
    return
  }
  stagedThisSession.delete(stagingId)
  await rm(filePath, { force: true }).catch((error) => {
    console.warn('[app-background] failed to discard a staged image', error)
  })
}

async function listImageFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && isAppBackgroundImageId(entry.name))
      .map((entry) => entry.name)
  } catch (error) {
    if (isENOENT(error)) {
      return []
    }
    throw error
  }
}

async function sweepUnreferencedImages(store: AppBackgroundSettingsStore): Promise<void> {
  const stagingDir = getAppBackgroundStagingDir()
  const staleStaged = (await listImageFiles(stagingDir)).filter(
    (name) => !stagedThisSession.has(name)
  )
  const appliedId = store.getSettings().appBackgroundImageId ?? null
  const appearanceDir = getAppBackgroundDir()
  const orphaned = (await listImageFiles(appearanceDir)).filter((name) => name !== appliedId)
  await Promise.all([
    ...staleStaged.map((name) => rm(join(stagingDir, name), { force: true })),
    ...orphaned.map((name) => rm(join(appearanceDir, name), { force: true }))
  ])
}

/**
 * Removes staged images from earlier sessions and committed images the settings no longer name
 * (e.g. a crash between rename and flush). Only feature-generated `<uuid>.<ext>` files are touched.
 */
export function sweepAppBackgroundImages(store: AppBackgroundSettingsStore): Promise<void> {
  // Why on the commit queue: mid-commit, the new image sits in appearance/ before settings name it.
  const run = commitQueue.then(() => sweepUnreferencedImages(store))
  commitQueue = run.catch(() => {})
  return run
}

export function registerAppBackgroundHandlers(store: AppBackgroundSettingsStore): void {
  ipcMain.handle('appBackground:pick', async (event): Promise<AppBackgroundPickResult> => {
    const senderWindow =
      BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: translateMain(
        'settings.appearance.background.pickDialogTitle',
        'Choose background image'
      ),
      properties: ['openFile'],
      filters: [{ name: 'Image', extensions: [...APP_BACKGROUND_IMAGE_EXTENSIONS] }]
    }
    const result = senderWindow
      ? await dialog.showOpenDialog(senderWindow, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) {
      return { status: 'canceled' }
    }
    return stageAppBackgroundImage(result.filePaths[0])
  })

  ipcMain.handle(
    'appBackground:read',
    async (_event, args: unknown): Promise<ArrayBuffer | null> => {
      const parsed = ReadArgsSchema.safeParse(args)
      if (!parsed.success) {
        throw new Error('Invalid appBackground:read arguments')
      }
      const filePath = resolveAppBackgroundImageFile(parsed.data.id, parsed.data.staging ?? false)
      if (!filePath) {
        return null
      }
      try {
        const buf = await readFile(filePath)
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      } catch {
        return null
      }
    }
  )

  ipcMain.handle(
    'appBackground:commit',
    async (_event, args: unknown): Promise<AppBackgroundCommitResult> => {
      const parsed = CommitArgsSchema.safeParse(args)
      if (!parsed.success) {
        return { ok: false, reason: 'invalidId' }
      }
      // Why serialize: two windows applying at once would each delete the image the other just set.
      const run = commitQueue.then(() => commitAppBackgroundImage(store, parsed.data.stagingId))
      commitQueue = run.catch(() => {})
      return run
    }
  )

  ipcMain.handle('appBackground:discard', async (_event, stagingId: unknown): Promise<void> => {
    if (typeof stagingId === 'string') {
      await discardAppBackgroundStaging(stagingId)
    }
  })
}
