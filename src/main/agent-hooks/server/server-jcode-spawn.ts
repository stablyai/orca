import type { IncomingMessage, ServerResponse } from 'node:http'
import { readRequestBody } from '../../../shared/agent-hook-listener/request-body'
import {
  JCODE_SPAWN_CREATE_BUDGET_MS,
  parseJcodeSpawnRequest,
  type JcodeSpawnRequest
} from '../../../shared/jcode-spawn-hook'

export type JcodeSpawnOutcome = 'done' | 'forbidden' | 'failed'
export type JcodeSpawnListener = (
  request: JcodeSpawnRequest,
  signal: AbortSignal
) => Promise<JcodeSpawnOutcome>

export async function handleJcodeSpawnRequest(
  req: IncomingMessage,
  res: ServerResponse,
  listener: JcodeSpawnListener | null,
  isCurrent: () => boolean,
  controllers: Set<AbortController>
): Promise<void> {
  let body: unknown
  try {
    body = await readRequestBody(req)
  } catch {
    // spawn body failures stay out of status transport-interference accounting.
    if (isCurrent() && !res.destroyed && !res.writableEnded) {
      res.writeHead(400)
      res.end()
    } else {
      res.destroy()
    }
    return
  }
  if (!isCurrent() || res.destroyed) {
    res.destroy()
    return
  }
  const request = parseJcodeSpawnRequest(body)
  if (!request || !listener) {
    res.writeHead(request ? 503 : 400)
    res.end()
    return
  }
  const controller = new AbortController()
  controllers.add(controller)
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (status?: number): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(deadline)
      controllers.delete(controller)
      controller.signal.removeEventListener('abort', onAbort)
      res.off('close', onClose)
      if (status !== undefined && isCurrent() && !res.destroyed) {
        if (status === 200) {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{"ok":true}')
        } else {
          res.writeHead(status)
          res.end()
        }
      } else {
        res.destroy()
      }
      resolve()
    }
    const onClose = (): void => {
      if (!res.writableEnded) {
        controller.abort('client_disconnected')
      }
    }
    const onAbort = (): void => finish(controller.signal.reason === 'deadline' ? 503 : undefined)
    const deadline = setTimeout(() => {
      controller.abort('deadline')
    }, JCODE_SPAWN_CREATE_BUDGET_MS)
    controller.signal.addEventListener('abort', onAbort, { once: true })
    res.on('close', onClose)
    void Promise.resolve()
      .then(() => listener(request, controller.signal))
      .then(
        (outcome) => finish(outcome === 'done' ? 200 : outcome === 'forbidden' ? 403 : 503),
        () => finish(503)
      )
  })
}
