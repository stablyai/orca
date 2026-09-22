import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

const BROKER_FLAG = 'ORCA_EXPERIMENTAL_WINDOWS_PIPE_BROKER'
const BROKER_ACCOUNT = 'ORCA_EXPERIMENTAL_WINDOWS_PIPE_BROKER_SANDBOX_ACCOUNT'
const TEST_ACCOUNT = 'ORCA_TEST_WINDOWS_PIPE_ACCOUNT'
const CLI_PATH = join(process.cwd(), 'out', 'cli', 'index.js')
const describeWindows = process.platform === 'win32' ? describe : describe.skip

const temporaryPaths: string[] = []

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

async function waitUntil(assertion: () => boolean, deadlineMs = 5_000): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (!assertion()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the runtime metadata transition.')
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
}

async function runBuiltCli(userDataPath: string): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  if (!existsSync(CLI_PATH)) {
    throw new Error('Build the CLI before running this integration test.')
  }
  const child = spawn(process.execPath, [CLI_PATH, 'status', '--json'], {
    env: { ...process.env, ORCA_USER_DATA_PATH: userDataPath },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', (code) => resolveExit(code ?? 1))
  })
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8')
  }
}

async function requestWithInvalidToken(endpoint: string): Promise<{
  ok: boolean
  error?: { code?: string }
}> {
  return await new Promise((resolveResponse, rejectResponse) => {
    const socket = createConnection(endpoint)
    let response = ''
    const timer = setTimeout(() => {
      socket.destroy()
      rejectResponse(new Error('Invalid-token RPC timed out.'))
    }, 5_000)
    socket.setEncoding('utf8')
    socket.once('error', rejectResponse)
    socket.on('data', (chunk: string) => {
      response += chunk
      const newline = response.indexOf('\n')
      if (newline === -1) {
        return
      }
      clearTimeout(timer)
      socket.end()
      resolveResponse(JSON.parse(response.slice(0, newline)) as never)
    })
    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify({
          id: 'invalid-token-test',
          authToken: 'invalid-test-token',
          method: 'status.get'
        })}\n`
      )
    })
  })
}

describeWindows('experimental Windows pipe broker with the real RPC handler', () => {
  it('carries the Node CLI request, rejects an invalid token, and retracts a dead broker', async () => {
    const authorizedAccount = process.env[TEST_ACCOUNT]?.trim()
    if (!authorizedAccount) {
      throw new Error(
        `${TEST_ACCOUNT} must be set from WindowsIdentity.GetCurrent().Name; the test never accepts an account claimed by the RPC client.`
      )
    }

    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-win-broker-rpc-'))
    temporaryPaths.push(userDataPath)
    const previousFlag = process.env[BROKER_FLAG]
    const previousAccount = process.env[BROKER_ACCOUNT]
    process.env[BROKER_FLAG] = '1'
    process.env[BROKER_ACCOUNT] = authorizedAccount

    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
    try {
      await server.start()
      const metadata = readRuntimeMetadata(userDataPath)
      expect(metadata).not.toBeNull()
      const brokerEndpoint = metadata?.transports.find((transport) =>
        transport.endpoint.startsWith('\\\\.\\pipe\\orca-broker-')
      )?.endpoint
      expect(brokerEndpoint).toBeTruthy()
      if (!brokerEndpoint) {
        throw new Error('The experimental broker endpoint was not published.')
      }

      // This is the compiled production CLI: it reads the isolated bootstrap file,
      // opens the first advertised named pipe through node:net, and reaches the real status handler.
      const valid = await runBuiltCli(userDataPath)
      expect(valid.exitCode, valid.stderr).toBe(0)
      expect(JSON.parse(valid.stdout)).toMatchObject({ ok: true })

      const invalid = await requestWithInvalidToken(brokerEndpoint)
      expect(invalid.ok).toBe(false)
      expect(invalid.error?.code).toBe('unauthorized')

      expect(server.terminateWindowsPipeBrokerForTest()).toBe(true)
      await waitUntil(() => {
        const current = readRuntimeMetadata(userDataPath)
        return (
          current !== null &&
          !current.transports.some((transport) => transport.endpoint === brokerEndpoint)
        )
      })
    } finally {
      await server.stop().catch(() => {})
      if (previousFlag === undefined) {
        delete process.env[BROKER_FLAG]
      } else {
        process.env[BROKER_FLAG] = previousFlag
      }
      if (previousAccount === undefined) {
        delete process.env[BROKER_ACCOUNT]
      } else {
        process.env[BROKER_ACCOUNT] = previousAccount
      }
    }
  }, 30_000)
})
