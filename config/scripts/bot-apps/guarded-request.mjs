import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { ipLiteralOf, isPublicAddress } from './public-address.mjs'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export class RefusedRequest extends Error {}

export async function resolveWithDns(hostname) {
  const records = await lookup(hostname, { all: true, verbatim: true })
  return records.map((record) => record.address)
}

/** Connects to the already-vetted address so a second DNS answer cannot swap the target. */
export function httpsTransport({ url, address, method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const outgoing = httpsRequest(
      {
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        signal,
        agent: false,
        lookup: (_host, options, done) => {
          const family = address.includes(':') ? 6 : 4
          if (options?.all) {
            done(null, [{ address, family }])
          } else {
            done(null, address, family)
          }
        }
      },
      (incoming) =>
        resolve({
          status: incoming.statusCode ?? 0,
          headers: incoming.headers,
          body: incoming,
          abandon: () => incoming.destroy()
        })
    )
    outgoing.on('error', reject)
    outgoing.end(body)
  })
}

function toHeaders(raw) {
  if (raw instanceof Headers) {
    return raw
  }
  const headers = new Headers()
  for (const [name, value] of Object.entries(raw ?? {})) {
    if (value !== undefined) {
      headers.set(name, Array.isArray(value) ? value.join(', ') : String(value))
    }
  }
  return headers
}

function untilAborted(signal) {
  const aborted = new Promise((_, reject) => {
    const fail = () => reject(new RefusedRequest('timed out'))
    if (signal.aborted) {
      fail()
    } else {
      signal.addEventListener('abort', fail, { once: true })
    }
  })
  aborted.catch(() => {})
  return aborted
}

async function readCapped(stream, maxBytes, aborted) {
  const reader = stream[Symbol.asyncIterator]()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.next(), aborted])
      if (done) {
        break
      }
      const chunk = typeof value === 'string' ? Buffer.from(value) : value
      size += chunk.byteLength
      if (size > maxBytes) {
        throw new RefusedRequest(`body passed ${maxBytes} bytes`)
      }
      chunks.push(chunk)
    }
  } finally {
    void reader.return?.()?.catch?.(() => {})
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * HTTPS client for probing third-party servers: public hosts only, capped bodies, a deadline per
 * request, hand-followed GET redirects, and POST allowed to one URL only.
 */
export function createGuardedClient({
  postUrl,
  resolveHost = resolveWithDns,
  transport = httpsTransport,
  timeoutMs = 10_000,
  maxBodyBytes = 1_000_000,
  maxRedirects = 5
}) {
  const allowedPost = new URL(postUrl).href

  async function vettedAddress(url, method) {
    if (url.protocol !== 'https:') {
      throw new RefusedRequest(`${url.href} is not https`)
    }
    if (url.username || url.password) {
      throw new RefusedRequest(`${url.origin} carries credentials in the URL`)
    }
    if (method === 'POST' && url.href !== allowedPost) {
      throw new RefusedRequest(`POST to ${url.href} is outside the app's MCP URL`)
    }
    const literal = ipLiteralOf(url.hostname)
    const addresses = literal ? [literal] : await resolveHost(url.hostname)
    if (addresses.length === 0) {
      throw new RefusedRequest(`${url.hostname} has no addresses`)
    }
    const blocked = addresses.find((address) => !isPublicAddress(address))
    if (blocked) {
      throw new RefusedRequest(`${url.hostname} resolves to non-public ${blocked}`)
    }
    return addresses[0]
  }

  async function exchange(method, url, headers, body) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const aborted = untilAborted(controller.signal)
    let response
    try {
      const address = await Promise.race([vettedAddress(url, method), aborted])
      response = await Promise.race([
        transport({ url, address, method, headers, body, signal: controller.signal }),
        aborted
      ])
      const responseHeaders = toHeaders(response.headers)
      if (REDIRECT_STATUSES.has(response.status)) {
        response.abandon?.()
        return { status: response.status, headers: responseHeaders, text: '' }
      }
      const text = await readCapped(response.body, maxBodyBytes, aborted)
      return { status: response.status, headers: responseHeaders, text }
    } catch (error) {
      response?.abandon?.()
      controller.abort()
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async function send(method, target, extraHeaders = {}, body = undefined) {
    const headers = {
      'user-agent': 'orca-bot-app-check',
      'accept-encoding': 'identity',
      ...extraHeaders
    }
    let url = new URL(target)
    for (let hops = 0; ; hops += 1) {
      const response = await exchange(method, url, headers, body)
      if (!REDIRECT_STATUSES.has(response.status)) {
        return { url: url.href, ...response }
      }
      if (method !== 'GET') {
        throw new RefusedRequest(`${method} ${url.href} answered ${response.status}; not followed`)
      }
      if (hops >= maxRedirects) {
        throw new RefusedRequest(`more than ${maxRedirects} redirects from ${target}`)
      }
      const location = response.headers.get('location')
      if (!location) {
        throw new RefusedRequest(`${url.href} answered ${response.status} without a Location`)
      }
      url = new URL(location, url)
    }
  }

  /** Applies the fetch rules to a URL we only report or hand on, without requesting it. */
  async function vet(target) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      await Promise.race([vettedAddress(new URL(target), 'GET'), untilAborted(controller.signal)])
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    vet,
    get: (url, headers) => send('GET', url, headers),
    post: (url, headers, body) => send('POST', url, headers, body)
  }
}
