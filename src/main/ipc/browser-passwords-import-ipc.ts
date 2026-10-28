import { BrowserWindow, dialog } from 'electron'
import { readFile, stat } from 'node:fs/promises'
import type { BrowserPasswordImportResult } from '../../shared/browser-passwords-types'
import { CHROMIUM_BROWSERS } from '../browser/cookies/sources/browser-cookie-detection-types'
import { readChromiumBrowserPasswords } from '../browser-passwords/browser-password-chromium-import'
import { parseBrowserPasswordCsv } from '../browser-passwords/browser-password-csv-import'
import { toBrowserPasswordOrigin } from '../browser-passwords/browser-password-origin'
import {
  handleBrowserPasswordsChannel,
  readBrowserPasswordsVaultRequest
} from './browser-passwords-ipc-request'

const CSV_MAX_BYTES = 1024 * 1024

export function registerBrowserPasswordsImportHandlers(): void {
  handleBrowserPasswordsChannel(
    'browserPasswords:importCsv',
    async (event, raw): Promise<BrowserPasswordImportResult> => {
      const request = readBrowserPasswordsVaultRequest(event, raw)
      if (!request) {
        return { ok: false, reason: 'unavailable' }
      }
      const availability = request.vault.availability()
      if (!availability.available) {
        return { ok: false, reason: 'unavailable', message: availability.reason }
      }
      const parent = BrowserWindow.fromWebContents(event.sender)
      const options: Electron.OpenDialogOptions = {
        properties: ['openFile'],
        filters: [{ name: 'CSV', extensions: ['csv'] }]
      }
      const picked = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      const filePath = picked.filePaths[0]
      if (picked.canceled || !filePath) {
        return { ok: false, reason: 'canceled' }
      }
      try {
        if ((await stat(filePath)).size > CSV_MAX_BYTES) {
          return { ok: false, reason: 'failed', message: 'too-large' }
        }
        const parsed = parseBrowserPasswordCsv(await readFile(filePath, 'utf8'))
        if (parsed.error) {
          return { ok: false, reason: 'failed', message: parsed.error }
        }
        const rows = parsed.rows.flatMap((row) => {
          const origin = toBrowserPasswordOrigin(row.url)
          return origin
            ? [{ origin, username: row.username, password: row.password, note: row.note }]
            : []
        })
        const imported = request.vault.importRows(rows)
        if (!imported.ok) {
          return { ok: false, reason: 'failed' }
        }
        const invalid = imported.value.invalid + parsed.invalid + (parsed.rows.length - rows.length)
        return { ok: true, summary: { ...imported.value, invalid } }
      } catch {
        return { ok: false, reason: 'failed' }
      }
    }
  )

  handleBrowserPasswordsChannel(
    'browserPasswords:importFromBrowser',
    async (event, raw): Promise<BrowserPasswordImportResult> => {
      const request = readBrowserPasswordsVaultRequest(event, raw)
      const source = request
        ? CHROMIUM_BROWSERS.find((browser) => browser.family === request.args.browserFamily)
        : undefined
      const profileDirectory = request?.args.profileDirectory
      if (!request || !source || typeof profileDirectory !== 'string') {
        return { ok: false, reason: 'unavailable' }
      }
      const availability = request.vault.availability()
      if (!availability.available) {
        return { ok: false, reason: 'unavailable', message: availability.reason }
      }
      const read = await readChromiumBrowserPasswords({
        browserFamily: source.family,
        profileDirectory
      })
      if (!read.ok) {
        return { ok: false, reason: 'failed', message: read.message }
      }
      const imported = request.vault.importRows(read.rows)
      return imported.ok
        ? { ok: true, summary: { ...imported.value, undecryptable: read.undecryptable } }
        : { ok: false, reason: 'failed' }
    }
  )
}
