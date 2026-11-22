import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchWithPinnedAddresses } from './pinned-address-fetch'

let server: http.Server | undefined
afterEach(() => server?.close())

describe('fetchWithPinnedAddresses', () => {
  it('connects to the pinned address and keeps the original Host, never re-resolving the name', async () => {
    let seenHost = ''
    server = http.createServer((req, res) => {
      seenHost = req.headers.host ?? ''
      res.writeHead(200, { 'content-type': 'image/png' }).end('png')
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const { port } = server.address() as AddressInfo

    // rebind.invalid cannot resolve; only the pinned address can reach the server.
    const response = await fetchWithPinnedAddresses(`http://rebind.invalid:${port}/f.png`, {}, [
      { address: '127.0.0.1' }
    ])

    expect(await response.text()).toBe('png')
    expect(seenHost).toBe(`rebind.invalid:${port}`)
  })

  it('hands a redirect back unfollowed', async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(302, { location: 'http://10.0.0.1/x' }).end()
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const { port } = server.address() as AddressInfo

    const response = await fetchWithPinnedAddresses(`http://rebind.invalid:${port}/`, {}, [
      { address: '127.0.0.1' }
    ])

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('http://10.0.0.1/x')
  })
})
