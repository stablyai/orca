import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { LocalBuildCandidate } from './local-build-candidate'

export type LocalBuildFeed = {
  url: string
  close: () => Promise<void>
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

export async function startLocalBuildFeed(candidate: LocalBuildCandidate): Promise<LocalBuildFeed> {
  const token = randomBytes(24).toString('hex')
  const prefix = `/${token}/`
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || !request.url) {
      response.writeHead(404).end()
      return
    }
    let pathname: string
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
    } catch {
      response.writeHead(400).end()
      return
    }
    if (!pathname.startsWith(prefix)) {
      response.writeHead(404).end()
      return
    }
    const filename = pathname.slice(prefix.length)
    if (filename === 'latest-mac.yml') {
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/yaml; charset=utf-8'
      })
      response.end(candidate.manifestContent)
      return
    }
    const artifact = candidate.artifacts.get(filename)
    if (!artifact) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/zip'
    })
    const stream = artifact.file.createReadStream({
      autoClose: false,
      start: 0,
      end: artifact.size - 1
    })
    stream.on('error', () => response.destroy())
    response.on('error', () => stream.destroy())
    response.on('close', () => stream.destroy())
    stream.pipe(response)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      server.on('error', (error) => console.warn('[updater] Local build feed error:', error))
      resolve()
    })
  }).catch(async (error) => {
    await candidate.close()
    throw error
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    await closeServer(server)
    await candidate.close()
    throw new Error('Could not start the local update feed.')
  }
  let closed = false
  return {
    url: `http://127.0.0.1:${address.port}${prefix}`,
    close: async () => {
      if (closed) {
        return
      }
      closed = true
      await closeServer(server)
      await candidate.close()
    }
  }
}
