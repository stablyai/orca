import path from 'node:path'
import { app, dialog, shell, type BrowserWindow } from 'electron'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import { translateMain } from '../i18n/main-i18n'
import { isBackgroundLaunch } from './foreground-activation-policy'
import {
  checkInstalledRendererAssets,
  type InstalledRendererAssetCheck
} from './installed-renderer-asset-integrity'

const DOWNLOAD_URL = 'https://github.com/stablyai/orca/releases/latest'
const NAMED_FILE_LIMIT = 3

let installCheck: Promise<InstalledRendererAssetCheck> | null = null
let noticeShown = false

/** A chunk that fails to parse after a reload is usually an edited install; say so instead of offering futile retries. */
export async function explainUnloadableRendererChunk(parent: BrowserWindow | null): Promise<void> {
  if (!app.isPackaged) {
    return
  }
  installCheck ??= checkInstalledRendererAssets(path.join(process.resourcesPath, 'app.asar'))
  const result = await installCheck
  if (result.status !== 'modified' || noticeShown) {
    return
  }
  noticeShown = true
  const named = result.files.slice(0, NAMED_FILE_LIMIT).join(', ')
  recordDurableCrashBreadcrumb('renderer_install_modified', {
    modifiedCount: result.files.length,
    files: named
  })
  console.warn(`[renderer] installed app files were modified after install: ${named}`)
  if (isBackgroundLaunch()) {
    return
  }
  const listed = result.files.length > NAMED_FILE_LIMIT ? `${named}, …` : named
  const options: Electron.MessageBoxOptions = {
    type: 'error',
    title: translateMain('modifiedInstall.title', 'Reinstall Orca'),
    message: translateMain(
      'modifiedInstall.message',
      'Some of Orca’s app files were changed after it was installed.'
    ),
    detail: translateMain(
      'modifiedInstall.detail',
      'Parts of Orca can’t load until it is reinstalled, and restarting won’t fix it. Changed files ({{fileCount}}): {{files}}\n\nReinstall Orca to restore them. Your workspaces and settings are kept.',
      { fileCount: result.files.length, files: listed }
    ),
    buttons: [
      translateMain('modifiedInstall.download', 'Open Download Page'),
      translateMain('modifiedInstall.close', 'Close')
    ],
    defaultId: 0,
    cancelId: 1
  }
  const { response } =
    parent && !parent.isDestroyed()
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
  if (response === 0) {
    await shell.openExternal(DOWNLOAD_URL)
  }
}
