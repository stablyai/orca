import { request } from 'node:http'
import { connect } from 'node:net'
import { describe, expect, it } from 'vitest'
import { serveHeldLoopbackCallback, serveLoopbackCallback } from './loopback-callback'

const ERRORS = {
  timeout: 'timeout',
  cancelled: 'cancelled',
  unavailable: 'unavailable',
  failed: 'failed'
}

function hit(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; csp: string; text: string }> {
  return new Promise((resolve, reject) => {
    const sent = request({ hostname: '127.0.0.1', port, path, ...options }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => (text += chunk))
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          csp: String(response.headers['content-security-policy']),
          text
        })
      )
    })
    sent.on('error', reject)
    sent.end()
  })
}

function listening(): { port: Promise<number>; onListening: (port: number) => void } {
  const port = Promise.withResolvers<number>()
  return { port: port.promise, onListening: port.resolve }
}

const read = (url: URL) =>
  url.searchParams.get('state') === 'S'
    ? { kind: 'accept' as const, value: url.search }
    : { kind: 'stray' as const, message: 'STRAY' }

describe('loopback callback listener', () => {
  it('hands a held caller the value before its outcome, and checks every request first', async () => {
    const ready = listening()
    const held = serveHeldLoopbackCallback({
      path: '/cb',
      timeoutMs: 60_000,
      errors: ERRORS,
      read,
      onListening: ready.onListening,
      hold: { received: 'RECEIVED|', pending: 'PENDING', ms: 60_000 }
    })
    const port = await ready.port
    const refusals = await Promise.all([
      hit(port, '/cb?state=S', { method: 'POST' }),
      hit(port, '/cb?state=S', { headers: { host: 'attacker.example' } }),
      hit(port, '/cb?state=X')
    ])
    expect(refusals.map(({ status }) => status)).toEqual([405, 421, 400])
    // Every answer carries the page security headers, refusals too.
    expect(refusals.every(({ csp }) => csp.includes("default-src 'none'"))).toBe(true)

    const tab = hit(port, '/cb?state=S')
    const { value, answer } = await held
    expect(value).toBe('?state=S')
    expect((await hit(port, '/cb?state=S')).status).toBe(410)
    answer('OUTCOME')
    expect(await tab).toMatchObject({ status: 200, text: 'RECEIVED|OUTCOME' })
  })

  it('ends a held tab with the pending part when the caller cancels after the return', async () => {
    const ready = listening()
    const stop = new AbortController()
    const held = serveHeldLoopbackCallback({
      path: '/cb',
      timeoutMs: 60_000,
      errors: ERRORS,
      read,
      signal: stop.signal,
      onListening: ready.onListening,
      hold: { received: 'RECEIVED|', pending: 'PENDING', ms: 60_000 }
    })
    const tab = hit(await ready.port, '/cb?state=S')
    await held
    stop.abort()
    expect((await tab).text).toBe('RECEIVED|PENDING')
  })

  it('resolves a streaming caller only once its page is finished', async () => {
    const ready = listening()
    const order: string[] = []
    const returned = serveLoopbackCallback({
      path: '/cb',
      timeoutMs: 60_000,
      errors: ERRORS,
      read,
      onListening: ready.onListening,
      successPage: {
        received: 'RECEIVED|',
        finish: async (value) => {
          order.push(`finish ${value}`)
          return 'DONE'
        }
      }
    })
    const tab = hit(await ready.port, '/cb?state=S')
    await returned.then(() => order.push('resolved'))
    expect(order).toEqual(['finish ?state=S', 'resolved'])
    expect((await tab).text).toBe('RECEIVED|DONE')
  })

  it('drops a connection that has not sent its whole request by the read deadline', async () => {
    const ready = listening()
    let accepted = false
    const returned = serveLoopbackCallback({
      path: '/cb',
      timeoutMs: 60_000,
      errors: ERRORS,
      read,
      onListening: ready.onListening,
      readDeadlineMs: 200,
      successPage: 'DONE'
    }).then((value) => {
      accepted = true
      return value
    })
    const port = await ready.port
    const slow = connect({ host: '127.0.0.1', port })
    let answered = ''
    slow.setEncoding('utf8')
    slow.on('data', (chunk: string) => (answered += chunk))
    const closed = new Promise<void>((resolve) => slow.once('close', () => resolve()))
    slow.on('error', () => {})
    slow.write(`GET /cb?state=S HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`)
    // The request never finishes: the listener drops the connection at its read deadline.
    await closed
    expect(answered).toBe('')
    expect(accepted).toBe(false)

    // The listener still takes a prompt return.
    expect((await hit(port, '/cb?state=S')).text).toBe('DONE')
    await expect(returned).resolves.toBe('?state=S')
  })
})
