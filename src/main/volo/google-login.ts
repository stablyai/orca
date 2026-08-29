import { createServer, type Server, type ServerResponse } from 'node:http'
import { shell } from 'electron'
import {
  parseVoloGoogleCallbackSearch,
  VOLO_GOOGLE_CLI_CALLBACK_PORT,
  voloGoogleCliAuthorizeUrl,
  type VoloGoogleSession
} from '../../shared/volo-google-session'

const AUTH_TIMEOUT_MS = 5 * 60 * 1000

const CALLBACK_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'text/html; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff'
} as const

const PAGE_STYLE = `<style>
  body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; }
  main { text-align: center; padding: 48px 24px; }
  h1 { font-size: 1.5rem; font-weight: 650; margin: 0; }
  p { color: #737373; margin: 12px 0 0; }
</style>`

const SUCCESS_PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Signed in to Volo</title>${PAGE_STYLE}</head>
  <body>
    <main>
      <h1>Signed in to Volo</h1>
      <p>You can close this tab and return to Orca.</p>
      <script>setTimeout(() => window.close(), 1500);</script>
    </main>
  </body>
</html>`

const ERROR_PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Volo sign-in failed</title>${PAGE_STYLE}</head>
  <body>
    <main>
      <h1>Volo sign-in failed</h1>
      <p>You can close this tab and try again from Orca.</p>
    </main>
  </body>
</html>`

function closeServer(server: Server): void {
  try {
    server.closeAllConnections?.()
    server.close()
  } catch {
    // Already closed.
  }
}

export function beginVoloGoogleCliLogin(apiUrl: string): Promise<VoloGoogleSession> {
  return new Promise((resolve, reject) => {
    let settled = false

    function finish(error: Error | null, session?: VoloGoogleSession): void {
      if (settled) {
        return
      }
      settled = true
      closeServer(server)
      if (error) {
        reject(error)
        return
      }
      if (!session) {
        reject(new Error('Google authentication failed.'))
        return
      }
      resolve(session)
    }

    const server = createServer((request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/callback') {
          response.writeHead(404)
          response.end('Not found')
          return
        }
        try {
          const session = parseVoloGoogleCallbackSearch(url.search)
          writeCallbackPage(response, 200, SUCCESS_PAGE)
          finish(null, session)
        } catch (error) {
          writeCallbackPage(response, 400, ERROR_PAGE)
          finish(error instanceof Error ? error : new Error('Google authentication failed.'))
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Google authentication failed.'))
      }
    })

    const timeout = setTimeout(() => {
      finish(new Error('Google sign-in timed out. Try again.'))
    }, AUTH_TIMEOUT_MS)
    server.once('close', () => clearTimeout(timeout))
    server.once('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EADDRINUSE') {
        finish(
          new Error(
            'Another Volo Google sign-in is already waiting. Finish that browser flow, or try again in a few minutes.'
          )
        )
        return
      }
      finish(error)
    })
    server.listen(VOLO_GOOGLE_CLI_CALLBACK_PORT, '127.0.0.1', () => {
      void shell.openExternal(voloGoogleCliAuthorizeUrl(apiUrl)).catch((error) => {
        finish(
          error instanceof Error
            ? error
            : new Error('Could not open the browser for Google sign-in.')
        )
      })
    })
  })
}

function writeCallbackPage(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, CALLBACK_HEADERS)
  response.end(body)
}
