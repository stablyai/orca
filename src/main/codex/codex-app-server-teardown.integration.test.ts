import { describe, expect, it } from 'vitest'
import { CODEX_SPAWN_TOKEN_ENV } from './codex-structured-owner-identity'
import {
  openCodexAppServerConnection,
  type CodexAppServerConnection
} from './codex-app-server-connection'

const ITERATIONS = 40

const FORCE_KILL_APP_SERVER = String.raw`
  const { spawn } = require('node:child_process')
  const readline = require('node:readline')
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
    stdio: 'ignore'
  })
  const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\n')
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.method === 'initialize') return send({ id: message.id, result: {} })
    if (message.method === 'initialized') {
      send({ method: 'test/descendant', params: { pid: descendant.pid } })
    }
  })
  setInterval(() => {}, 60000)
`

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

type RunningServer = {
  connection: CodexAppServerConnection
  descendantPid: number
}

async function openServer(iteration: number): Promise<RunningServer> {
  const descendant = Promise.withResolvers<number>()
  const connection = await openCodexAppServerConnection(
    {
      command: process.execPath,
      args: ['-e', FORCE_KILL_APP_SERVER],
      env: { [CODEX_SPAWN_TOKEN_ENV]: `teardown-test-${process.pid}-${iteration}` }
    },
    {
      onNotification: (method, params) => {
        if (method === 'test/descendant') {
          descendant.resolve((params as { pid: number }).pid)
        }
      }
    }
  )
  return { connection, descendantPid: await descendant.promise }
}

describe.runIf(process.platform === 'linux')('Codex app-server process teardown', () => {
  it('reaps the forced-close descendant in 40 consecutive launches', async () => {
    const running: RunningServer[] = []
    try {
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        running.push(await openServer(iteration))
      }
      expect(running.every(({ descendantPid }) => processExists(descendantPid))).toBe(true)

      const closed = await Promise.all(running.map(({ connection }) => connection.close()))

      expect(closed).toEqual(Array.from({ length: ITERATIONS }, () => true))
      expect(running.filter(({ descendantPid }) => processExists(descendantPid))).toEqual([])
    } finally {
      for (const { connection, descendantPid } of running) {
        await connection.close().catch(() => false)
        if (processExists(descendantPid)) {
          process.kill(descendantPid, 'SIGKILL')
        }
      }
    }
  }, 30_000)
})
