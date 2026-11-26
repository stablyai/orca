import type { App } from 'electron'

export function declineBackgroundClientCertificates(app: App): void {
  app.on('select-client-certificate', (event, webContents, _url, _certificates, callback) => {
    if (webContents !== null) {
      return
    }
    // Background net requests must not silently present the user's first matching certificate.
    event.preventDefault()
    callback()
  })
}
