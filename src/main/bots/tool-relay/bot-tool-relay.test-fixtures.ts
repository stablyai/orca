// A fake MCP server and agent for the relay's tests.
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse
} from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { setSecretStore } from '../../../shared/secure-storage/secret-store'
import { botToolsPath } from '../bot-tools-path'

const servers: Server[] = []

export const json = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream'
}

export type Seen = { method?: string; path: string; headers: IncomingHttpHeaders; body: string }

/** An upstream MCP server that records what it got and answers with `reply`. */
export async function upstream(
  reply: (seen: Seen, res: ServerResponse) => void
): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const entry = { method: req.method, path: req.url ?? '', headers: req.headers, body }
      seen.push(entry)
      reply(entry, res)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : 0
  return { url: `http://127.0.0.1:${port}/mcp`, seen }
}

export function call(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: options.method ?? 'POST', headers: options.headers },
      (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      }
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

export function closeUpstreams(): void {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    server.close()
  }
}

/** A sealing store, as a host with an OS keyring has: saved values are sealed, never plaintext. */
export function installFakeSealingStore(): void {
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`sealed(${text})`, 'utf8'),
    decryptString: (cipher) => cipher.toString('utf8').replace(/^sealed\((.*)\)$/s, '$1'),
    describeProtectionGap: () => null
  })
}

/** The bot's tools file naming each credential at its address, as Orca writes it. */
export function writeToolsFile(folder: string, tools: Record<string, string>): void {
  mkdirSync(dirname(botToolsPath(folder)), { recursive: true })
  const servers = Object.entries(tools).map(([credential, url], index) => ({
    name: `tool-${index}`,
    url,
    credential
  }))
  writeFileSync(botToolsPath(folder), JSON.stringify({ servers }))
}
