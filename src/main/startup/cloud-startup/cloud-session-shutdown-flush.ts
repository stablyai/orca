import { app, powerMonitor, type Event } from 'electron'

// Route OS shutdown through awaited quit teardown; Windows reports session-end per window.
export function installCloudSessionShutdownFlush(): void {
  powerMonitor.on('shutdown', (event?: Event) => {
    event?.preventDefault()
    app.quit()
  })
}
