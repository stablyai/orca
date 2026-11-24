import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export type LinearHttpReceipt = {
  query: string
  variables?: Record<string, unknown>
  headers: IncomingMessage['headers']
  method: string | undefined
}

export async function serveLinearHttp(
  handle: (receipt: LinearHttpReceipt, response: ServerResponse) => void
) {
  const receipts: LinearHttpReceipt[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      const receipt: LinearHttpReceipt = {
        ...JSON.parse(body),
        headers: request.headers,
        method: request.method
      }
      receipts.push(receipt)
      handle(receipt, response)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(Number(process.env.ORCA_E2E_LINEAR_HTTP_PORT ?? 0), '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing loopback address')
  }
  return {
    apiUrl: `http://127.0.0.1:${address.port}/graphql`,
    receipts,
    async close() {
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
      server.closeAllConnections()
      await closed
    }
  }
}

export function sendLinearData(response: ServerResponse, data: unknown) {
  response.writeHead(200, { 'content-type': 'application/json', 'x-linear-proof': 'retained' })
  response.end(JSON.stringify({ data, extensions: { proof: 'retained' } }))
}
