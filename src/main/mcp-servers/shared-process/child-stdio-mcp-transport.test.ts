import { once } from 'node:events'
import { spawnProcess } from '@orca/process-host'
import { expect, it } from 'vitest'
import { ChildStdioMcpTransport } from './child-stdio-mcp-transport'

it('rejects a backpressured send when the child exits without reading it', async () => {
  const child = spawnProcess({
    program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
    args: ['-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
    stdio: 'pipe',
    timeoutMs: null
  })
  const ready = once(child.stdout, 'data')
  const closed = once(child, 'close')
  child.stderr.resume()
  const transport = new ChildStdioMcpTransport(child)
  await transport.start()
  try {
    await ready
    const sent = transport.send({
      jsonrpc: '2.0',
      method: 'notifications/test',
      params: { text: 'x'.repeat(8 * 1024 * 1024) }
    })
    child.kill('SIGKILL')
    await expect(sent).rejects.toBeInstanceOf(Error)
  } finally {
    child.kill('SIGKILL')
    await closed
  }
})
