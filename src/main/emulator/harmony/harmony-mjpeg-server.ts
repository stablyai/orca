import { createServer, type Server, type ServerResponse } from 'node:http'

export type HarmonyMjpegServer = {
  streamUrl: string
  stop: () => Promise<void>
}

export type StartHarmonyMjpegServerParams = {
  captureFrame: () => Promise<Buffer>
  frameIntervalMs?: number
  // Inject the http server factory (tests); defaults to node's createServer.
  createServer?: typeof createServer
}

const DEFAULT_FRAME_INTERVAL_MS = 200
const BOUNDARY = 'orca-harmony-frame'

// Starts a loopback MJPEG server fed by an injected frame capturer. The capture
// loop runs only while at least one client is subscribed, so a hidden pane
// costs no hdc snapshots.
export async function startHarmonyMjpegServer(
  params: StartHarmonyMjpegServerParams
): Promise<HarmonyMjpegServer> {
  const intervalMs = params.frameIntervalMs ?? DEFAULT_FRAME_INTERVAL_MS
  const subscribers = new Set<ServerResponse>()
  // Subscribers whose socket buffer is full; frames are dropped until drain.
  const saturated = new Set<ServerResponse>()
  let timer: NodeJS.Timeout | null = null
  let capturing = false
  let stopped = false

  const broadcast = (jpeg: Buffer): void => {
    const frame = Buffer.concat([
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`
      ),
      jpeg,
      Buffer.from('\r\n')
    ])
    for (const res of subscribers) {
      if (res.writableEnded || res.destroyed) {
        subscribers.delete(res)
        saturated.delete(res)
        continue
      }
      if (saturated.has(res)) {
        continue
      }
      try {
        if (!res.write(frame)) {
          saturated.add(res)
          res.once('drain', () => saturated.delete(res))
        }
      } catch {
        subscribers.delete(res)
        saturated.delete(res)
      }
    }
  }

  const captureLoop = (): void => {
    if (stopped || subscribers.size === 0) {
      timer = null
      return
    }
    if (capturing) {
      timer = setTimeout(captureLoop, intervalMs)
      return
    }
    capturing = true
    params
      .captureFrame()
      .then((jpeg) => {
        if (!stopped) {
          broadcast(jpeg)
        }
      })
      .catch(() => {
        // A failed capture (target briefly busy) is skipped; next tick retries.
      })
      .finally(() => {
        capturing = false
        if (!stopped && subscribers.size > 0) {
          timer = setTimeout(captureLoop, intervalMs)
        }
      })
  }

  const ensureLoopRunning = (): void => {
    if (timer === null && !stopped) {
      timer = setTimeout(captureLoop, 0)
    }
  }

  const server: Server = (params.createServer ?? createServer)((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/stream.mjpeg') {
      res.statusCode = 404
      res.end()
      return
    }
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-cache',
      Connection: 'close'
    })
    subscribers.add(res)
    res.on('close', () => subscribers.delete(res))
    ensureLoopRunning()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : 0
  const streamUrl = `http://127.0.0.1:${port}/stream.mjpeg`

  return {
    streamUrl,
    stop: () =>
      new Promise((resolve) => {
        stopped = true
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        for (const res of subscribers) {
          res.destroy()
        }
        subscribers.clear()
        server.close(() => resolve())
      })
  }
}
