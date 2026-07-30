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
        args: ['-e', server],
        envToDelete: ['CODEX_HOME'],
        timeoutMs: 5_000
      },
      ({ request }) => request('env/get')
    )

    expect(result).toEqual({ codexHome: null })
  })
})
