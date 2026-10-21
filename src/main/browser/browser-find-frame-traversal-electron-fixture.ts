import { app, BrowserWindow } from 'electron'
import { applyBackgroundActivationPolicy } from '../window/foreground-activation-policy'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Find traversal fixture requires background launch')
}
applyBackgroundActivationPolicy()

async function run(): Promise<void> {
  await app.whenReady()
  const window = new BrowserWindow({
    show: false,
    webPreferences: { webviewTag: true, backgroundThrottling: false }
  })
  const before = '<iframe src="data:text/html,host before"></iframe>'
  const after = '<iframe src="data:text/html,host after"></iframe>'
  const guestURL = `data:text/html,${encodeURIComponent('<p>needle one</p><p>needle two</p>')}`
  const guestReadyScript = `(() => {
    const range = document.createRange();
    range.selectNodeContents(document.body);
    const bounds = range.getBoundingClientRect();
    return document.readyState === 'complete'
      && location.href === ${JSON.stringify(guestURL)}
      && document.body.textContent === 'needle oneneedle two'
      && bounds.width > 0 && bounds.height > 0;
  })()`
  const results: unknown[] = []
  for (const position of ['before', 'after', 'both']) {
    await window.loadURL(
      `data:text/html,${encodeURIComponent(`<!doctype html><body>
        ${position !== 'after' ? before : ''}
        <input id="query" value="needle">
        <webview style="width:600px;height:300px"></webview>
        ${position !== 'before' ? after : ''}
        <script>
          const guest = document.querySelector('webview');
          const guestURL = ${JSON.stringify(guestURL)};
          window.findFixtureReady = new Promise(resolve => {
            const listener = () => {
              if (guest.getURL() !== guestURL) return;
              guest.removeEventListener('did-finish-load', listener);
              resolve(guest.executeJavaScript(${JSON.stringify(guestReadyScript)}));
            };
            guest.addEventListener('did-finish-load', listener);
            guest.src = guestURL;
          });
        </script>`)}`
    )
    const ready: unknown = await window.webContents.executeJavaScript('window.findFixtureReady')
    if (ready !== true) {
      throw new Error(`Find traversal guest is not ready: ${position}`)
    }
    // Keep the search field focused, as BrowserFind does while typing and pressing Enter.
    const result: unknown = await window.webContents.executeJavaScript(`(async () => {
      const guest = document.querySelector('webview');
      const results = [];
      for (const forward of ${JSON.stringify(position === 'after' ? [false, true] : [true, false])}) {
        guest.stopFindInPage('clearSelection');
        for (let step = 0; step < 4; step++) {
          document.querySelector('input').focus();
          const result = await new Promise(resolve => {
            let requestId = -1;
            const listener = event => {
              if (event.result.requestId === requestId && event.result.finalUpdate) {
                guest.removeEventListener('found-in-page', listener);
                resolve(event.result);
              }
            };
            guest.addEventListener('found-in-page', listener);
            requestId = guest.findInPage('needle', { findNext: step === 0, forward });
          });
          results.push({ forward, matches: result.matches, ordinal: result.activeMatchOrdinal });
        }
      }
      guest.stopFindInPage('clearSelection');
      return results;
    })()`)
    results.push({ position, results: result })
  }
  console.log(
    `FIND_TRAVERSAL_RESULT:${JSON.stringify({ electron: process.versions.electron, hidden: !window.isVisible(), results })}`
  )
  window.destroy()
  app.exit(0)
}

void run().catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
