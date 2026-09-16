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
  const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 60000)"], {
    stdio: 'ignore'
  })
  const exitMode = process.env.ORCA_TEST_PROVIDER_EXIT_MODE
  const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\n')
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.method === 'initialize') return send({ id: message.id, result: {} })
    if (message.method === 'initialized') {
      send({ method: 'test/descendant', params: { pid: descendant.pid } })
      if (exitMode === 'normal' || exitMode === 'stdin-race') {
        setTimeout(() => process.exit(0), 25)
      } else if (exitMode === 'signal') {
        setTimeout(() => process.kill(process.pid, 'SIGTERM'), 25)
      }
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
  exit: Promise<Error>
  supervisorPid: number
}

async function openServer(
  iteration: number,
  exitMode?: 'normal' | 'signal' | 'stdin-race'
): Promise<RunningServer> {
  const descendant = Promise.withResolvers<number>()
  const exit = Promise.withResolvers<Error>()
  const connection = await openCodexAppServerConnection(
    {
      command: process.execPath,
      args: ['-e', FORCE_KILL_APP_SERVER],
      env: {
        [CODEX_SPAWN_TOKEN_ENV]: `teardown-test-${process.pid}-${iteration}`,
        ...(exitMode ? { ORCA_TEST_PROVIDER_EXIT_MODE: exitMode } : {})
      }
    },
    {
      onExit: (error) => exit.resolve(error),
      onNotification: (method, params) => {
        if (method === 'test/descendant') {
          descendant.resolve((params as { pid: number }).pid)
        }
      }
    }
  )
  return {
    connection,
    descendantPid: await descendant.promise,
    exit: exit.promise,
    supervisorPid: connection.pid ?? 0
  }
}

async function cleanupServer(server: RunningServer): Promise<void> {
  await server.connection.close().catch(() => false)
  for (const pid of [server.descendantPid, server.supervisorPid]) {
    if (pid > 0 && processExists(pid)) {
      process.kill(pid, 'SIGKILL')
    }
  }
}

describe.runIf(process.platform !== 'win32')('Codex app-server process teardown', () => {
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
      for (const server of running) {
        await cleanupServer(server)
      }
    }
  }, 30_000)

  it.each(['normal', 'signal'] as const)(
    'reaps provider descendants before relaying a %s root exit in 40 consecutive launches',
    async (exitMode) => {
      for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
        const server = await openServer(iteration, exitMode)
        try {
          await server.exit
          expect(processExists(server.supervisorPid)).toBe(false)
          expect(processExists(server.descendantPid)).toBe(false)
          await expect(server.connection.close()).resolves.toBe(true)
        } finally {
          await cleanupServer(server)
        }
      }
    },
    60_000
  )

  it('does not settle a stdin-close/root-exit race before the descendant is reaped', async () => {
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const server = await openServer(iteration, 'stdin-race')
      try {
        await expect(server.connection.close()).resolves.toBe(true)
        expect(processExists(server.supervisorPid)).toBe(false)
        expect(processExists(server.descendantPid)).toBe(false)
      } finally {
        await cleanupServer(server)
      }
    }
  }, 60_000)
})
