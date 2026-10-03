import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { createServer, normalizePath } from 'vite'
import { RemoteBrowserSocksServer } from '../../../src/main/browser/remote-browser-socks-server'

export async function createRoute(route: string) {
  const directory = await mkdtemp(join(tmpdir(), 'orca-route-' + route))
  let server: Awaited<ReturnType<typeof createServer>> | undefined
  let socks: RemoteBrowserSocksServer | undefined
  async function close() {
    try {
      await socks?.close()
    } finally {
      try {
        await server?.close()
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }
  }
  try {
    const root = await realpath(directory)
    const reports: { time: number; body: string }[] = []
    const targets: { host: string; port: number }[] = []
    const revision = (value: number) =>
      writeFile(join(root, 'revision.js'), `export const revision = ${value}\n`)
    await revision(1)
    await writeFile(
      join(root, 'index.html'),
      `<!doctype html><title>Route ${route}</title><script type="module" src="/main.js"></script>`
    )
    await writeFile(
      join(root, 'main.js'),
      `
import { revision } from '/revision.js'
const route = ${JSON.stringify(route)}
const previous = localStorage.getItem('route')
const previousCookie = document.cookie
localStorage.setItem('route', route)
document.cookie = 'route=' + route + '; max-age=3600; path=/'
let current = revision
const page = crypto.randomUUID()
function report(kind) {
  const data = {route, previous, previousCookie, stored:localStorage.getItem('route'),
    cookie:document.cookie, revision:current, kind, page, url:location.href}
  console.log('PROOF ' + JSON.stringify(data))
  fetch('/report', {method:'POST', body:JSON.stringify(data)})
}
report('load')
setInterval(() => report('fetch'), 1000)
if (import.meta.hot) import.meta.hot.accept('/revision.js', module => {
  current = module.revision
  report('hmr')
})
`
    )
    server = await createServer({
      configFile: false,
      root,
      logLevel: 'error',
      server: {
        host: '127.0.0.1',
        port: 0,
        hmr: { clientPort: 5173 },
        // Late creation events for immutable HTML must not queue a startup reload.
        watch: { ignored: [normalizePath(join(root, 'index.html'))] }
      },
      plugins: [
        {
          name: 'route-reports',
          configureServer(vite) {
            vite.middlewares.use('/report', (request, response) => {
              let body = ''
              request.on('data', (chunk) => {
                body += chunk
              })
              request.on('end', () => {
                reports.push({ time: Date.now(), body })
                response.end('ok')
              })
            })
          }
        }
      ]
    })
    await server.listen()
    const address = server.httpServer?.address()
    if (!address || typeof address === 'string') {
      throw new Error('Vite did not bind')
    }
    socks = new RemoteBrowserSocksServer({
      open: async (target) => {
        targets.push(target)
        if (target.host !== 'localhost' || target.port !== 5173) {
          throw new Error('Unexpected target')
        }
        return new Promise((resolve, reject) => {
          const socket = connect(address.port, '127.0.0.1')
          socket.once('error', reject)
          socket.once('connect', () => resolve(socket))
        })
      }
    })
    const proxy = await socks.listen()
    return {
      route,
      reports,
      targets,
      proxy,
      revision,
      close
    }
  } catch (error) {
    await close()
    throw error
  }
}
