import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runCodexAppServerSession } from './codex-app-server-session'

const originalCodexHome = process.env.CODEX_HOME
const tempRoots: string[] = []

afterEach(async () => {
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = originalCodexHome
  }
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('runCodexAppServerSession environment', () => {
  it('exposes the home selected inside a Codex launcher wrapper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-codex-wrapper-'))
    tempRoots.push(root)
    const wrapper = join(root, 'codex')
    const serverPath = join(root, 'fake-app-server.cjs')
    const server = String.raw`
      const readline = require('node:readline')
      readline.createInterface({ input: process.stdin }).on('line', (line) => {
        const message = JSON.parse(line)
        if (message.method === 'initialize') {
          process.stdout.write(JSON.stringify({ id: message.id, result: { codexHome: process.env.CODEX_HOME ?? null } }) + '\n')
        }
      })
    `
    await writeFile(serverPath, server, 'utf8')
    await writeFile(
      wrapper,
      '#!/bin/sh\nset -eu\nexport CODEX_HOME="$HOME/.codex-openai"\nexec "$ORCA_TEST_NODE" "$ORCA_TEST_APP_SERVER" "$@"\n',
      'utf8'
    )
    await chmod(wrapper, 0o755)

    const result = await runCodexAppServerSession(
      {
        command: wrapper,
        cliPath: wrapper,
        args: ['app-server'],
        env: {
          HOME: root,
          ORCA_TEST_NODE: process.execPath,
          ORCA_TEST_APP_SERVER: serverPath
        },
        timeoutMs: 5_000
      },
      async (_rpc, initializeResult) => initializeResult
    )

    expect(result).toEqual({ codexHome: join(root, '.codex-openai') })
  })

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
