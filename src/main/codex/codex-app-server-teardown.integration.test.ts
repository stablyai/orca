import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV } from '../../shared/agent-session-caller-env'
import {
  openCodexAppServerConnection,
  type CodexAppServerConnection
} from './codex-app-server-connection'

const ITERATIONS = 40

const DETACHED_GRANDCHILD_APP_SERVER = String.raw`
  const { spawn } = require('node:child_process')
  const readline = require('node:readline')
  const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 60000)"], {
    detached: true,
    stdio: 'ignore'
  })
  const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\n')
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line)
    if (message.method === 'initialize') send({ id: message.id, result: {} })
    if (message.method === 'initialized') {
      send({ method: 'test/grandchild', params: { provider: process.pid, grandchild: grandchild.pid } })
    }
  })
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 60000)
`

function processIdentity(pid: number): string | null {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
      encoding: 'utf8'
    }).trim()
  } catch {
    return null
  }
}

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
        [ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV]: `teardown-test-${process.pid}-${exitMode ?? 'forced'}-${iteration}`,
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
  it('reaps a grandchild in its own session after an unresponsive provider root', async () => {
    const observed = Promise.withResolvers<{ provider: number; grandchild: number }>()
    const connection = await openCodexAppServerConnection(
      { command: process.execPath, args: ['-e', DETACHED_GRANDCHILD_APP_SERVER] },
      {
        onNotification: (method, params) => {
          if (
            method === 'test/grandchild' &&
            typeof params === 'object' &&
            params !== null &&
            'provider' in params &&
            'grandchild' in params &&
            typeof params.provider === 'number' &&
            typeof params.grandchild === 'number'
          ) {
            observed.resolve({ provider: params.provider, grandchild: params.grandchild })
          }
        }
      }
    )
    const pids = await observed.promise
    const identities = [connection.pid, pids.provider, pids.grandchild]
      .filter((pid): pid is number => typeof pid === 'number')
      .map((pid) => ({ pid, identity: processIdentity(pid) }))
    try {
      expect(processExists(pids.grandchild)).toBe(true)
      const rootExited = await connection.close()
      expect(rootExited).toBe(true)
      if (connection.closeResult?.tree === 'exited') {
        await vi.waitFor(() => expect(processExists(pids.grandchild)).toBe(false))
        expect(connection.closeResult).toMatchObject({ root: 'exited', tree: 'exited' })
      } else {
        expect(connection.closeResult?.tree).not.toBe('exited')
        expect(connection.processTreeUnproven).toBe(true)
      }
    } finally {
      await connection.close().catch(() => false)
      for (const { pid, identity } of identities) {
        if (identity && processIdentity(pid) === identity) {
          process.kill(pid, 'SIGKILL')
        }
      }
    }
  }, 30_000)

  it.concurrent('does not settle a stdin-close/root-exit race before the descendant is reaped', async ({
    expect
  }) => {
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
