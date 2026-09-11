import { afterEach, describe, expect, it } from 'vitest'
import { runCodexAppServerSession } from './codex-app-server-session'

const originalCodexHome = process.env.CODEX_HOME

afterEach(() => {
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = originalCodexHome
  }
})

describe('runCodexAppServerSession environment', () => {
  it('removes inherited variables requested by a default-home invocation', async () => {
    process.env.CODEX_HOME = '/tmp/inherited-managed-home'
    const server = String.raw`
      const readline = require('node:readline')
      readline.createInterface({ input: process.stdin }).on('line', (line) => {
        const message = JSON.parse(line)
        if (typeof message.id !== 'number') return
        const result = message.method === 'env/get'
          ? { codexHome: process.env.CODEX_HOME ?? null }
          : {}
        process.stdout.write(JSON.stringify({ id: message.id, result }) + '\n')
      })
    `

    const result = await runCodexAppServerSession(
      {
        command: process.execPath,
        cliPath: null,
        args: ['-e', server],
        envToDelete: ['CODEX_HOME'],
        timeoutMs: 5_000
      },
      ({ request }) => request('env/get')
    )

    expect(result).toEqual({ codexHome: null })
  })

  it('keeps the session alive after a large legitimate response', async () => {
    const server = String.raw`
      const readline = require('node:readline')
      readline.createInterface({ input: process.stdin }).on('line', (line) => {
        const message = JSON.parse(line)
        if (typeof message.id !== 'number') return
        const result = message.method === 'test/large'
          ? { data: 'x'.repeat(1024 * 1024 + 1) }
          : { alive: true }
        process.stdout.write(JSON.stringify({ id: message.id, result }) + '\n')
      })
    `

    const result = await runCodexAppServerSession(
      {
        command: process.execPath,
        cliPath: null,
        args: ['-e', server],
        timeoutMs: 5_000
      },
      async ({ request }) => {
        const large = (await request('test/large')) as { data: string }
        const followup = await request('test/followup')
        return { largeBytes: Buffer.byteLength(large.data, 'utf8'), followup }
      }
    )

    expect(result).toEqual({ largeBytes: 1024 * 1024 + 1, followup: { alive: true } })
  })
})
