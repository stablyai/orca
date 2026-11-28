import { once } from 'node:events'
import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { fetchPluginKillList } from './plugin-kill-list-service'

it.each([
  { status: 503, headers: {}, error: 'HTTP 503' },
  { status: 200, headers: { 'content-length': '999999999' }, error: 'size limit' }
])('releases a rejected plugin response ($error)', async ({ status, headers, error }) => {
  const server = createServer((_req, res) => {
    res.writeHead(status, headers)
    res.write('an unfinished response')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const captured: { response?: Response } = {}
  try {
    const url = `http://127.0.0.1:${typeof address === 'object' ? address!.port : 0}/list`
    await expect(
      fetchPluginKillList(async (input, init) => {
        captured.response = await fetch(input, init)
        return captured.response
      }, url)
    ).rejects.toThrow(error)
    const reader = captured.response!.body!.getReader()
    const next = await reader.read()
    await reader.cancel()
    reader.releaseLock()
    expect(next.done).toBe(true)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
