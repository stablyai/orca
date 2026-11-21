import { app, BrowserWindow } from 'electron'
import {
  getDocPreviewGrant,
  mintDocPreviewGrant
} from '../../browser/document-preview/doc-preview-grant-registry'
import { installMainWindowWebviewSecurity } from '../security/main-window-webview-security'

async function run(): Promise<void> {
  const uncaught: string[] = []
  process.on('uncaughtException', (error) => uncaught.push(error.message))
  app.on('window-all-closed', () => {})
  await app.whenReady()
  const window = new BrowserWindow({ show: false })
  // Registered first: a throwing teardown listener would stop later listeners from running.
  const destroyed = new Promise<void>((resolve) => window.webContents.once('destroyed', resolve))
  installMainWindowWebviewSecurity(window)
  const grant = mintDocPreviewGrant({
    owner: { kind: 'ssh', connectionId: 'fixture' },
    root: '/workspace',
    entryRelativePath: 'README.md',
    browserPageId: 'fixture-page'
  })
  // destroy() tears the BrowserWindow down before its WebContents, as the quit-ack fallback does.
  window.destroy()
  await destroyed
  // Let an exception thrown by a later teardown listener reach the handler.
  await new Promise(setImmediate)
  console.log(JSON.stringify({ uncaught, grantRevoked: getDocPreviewGrant(grant.id) === null }))
  app.exit(0)
}

run().catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
