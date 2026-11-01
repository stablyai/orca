import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { probeAntigravityAcpServer } from './antigravity-acp-runtime-probe'

const folders: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(folders.splice(0).map((f) => rm(f, { recursive: true, force: true })))
})

async function fakeServer(): Promise<string> {
  const recording = await readFile(
    new URL('../acp/fixtures/antigravity-v1-question.jsonl', import.meta.url),
    'utf8'
  )
  const initialize = JSON.parse(recording.split('\n')[0]).message.result
  const folder = await mkdtemp(join(tmpdir(), 'orca-antigravity-probe-test-'))
  folders.push(folder)
  const server = join(folder, 'agy_acp_server.par')
  await writeFile(
    server,
    `#!${process.execPath}
const result = ${JSON.stringify(initialize)}
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method } = JSON.parse(line)
  if (method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
})
`
  )
  await chmod(server, 0o755)
  return server
}

it.skipIf(process.platform === 'win32')(
  'an install accepts only the pinned release, and only once its server stopped',
  async () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    const signal = new AbortController().signal
    const pinned = probeAntigravityAcpServer(await fakeServer(), '1.3.0', signal)
    await expect(pinned).resolves.toBeUndefined()
    const other = probeAntigravityAcpServer(await fakeServer(), '1.4.0', signal)
    await expect(other).rejects.toThrow('Antigravity could not start on this host.')
  }
)
