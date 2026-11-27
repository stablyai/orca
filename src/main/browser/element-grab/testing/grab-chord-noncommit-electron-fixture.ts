import { createServer } from 'node:http'
import type { WebContents } from 'electron'

/** HTTP 204 starts navigation but leaves the original preload and document alive. */
export async function verifyGrabChordNonCommit(
  page: WebContents,
  pages: string[],
  chord: (key: string, shift: boolean) => Promise<void>
) {
  const server = createServer((_request, response) => {
    response.writeHead(204)
    response.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Missing synthetic server')
    }
    await page.executeJavaScript('window.__sameDocument = true; true')
    await page.loadURL(`http://127.0.0.1:${address.port}/no-content`).catch(() => {})
    const deadline = Date.now() + 5_000
    while (page.isLoadingMainFrame()) {
      if (Date.now() > deadline) {
        throw new Error('204 navigation did not end')
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    await page.executeJavaScript(
      "document.getElementById('search').setSelectionRange(0,0);window.getSelection()?.removeAllRanges();document.getElementById('buy').focus();window.__pageKeys=[]"
    )
    pages.length = 0
    await chord('G', true)
    return {
      documentKept: await page.executeJavaScript('window.__sameDocument === true'),
      pages: [...pages],
      pageSawChord: await page.executeJavaScript(
        "window.__pageKeys.some(key=>key.toLowerCase()==='g')"
      )
    }
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
