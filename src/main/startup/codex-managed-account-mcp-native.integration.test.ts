import { runProcessSync } from '../../shared/child-process/run-process'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeOs from 'node:os'
import { openCodexAppServerConnection } from '../codex/codex-app-server-connection'
import { openCodexThread } from '../codex/codex-structured-thread-open'
import { MANAGED_CODEX_HOME_PLACEHOLDER } from '../codex/codex-managed-home-mcp-binding'
import { resolveCodexCommand } from '../codex-cli/command'
import { createSettings } from '../codex-accounts/runtime-home-settings-test-fixtures'
import {
  createManagedAuth,
  createStore,
  getSystemCodexHomePath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from '../codex-accounts/runtime-home-service-test-harness'

vi.mock('electron', () => ({ app: { getPath: () => testState.userDataDir } }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return { ...actual, homedir: () => testState.fakeHomeDir }
})
vi.mock('../agent-trust-presets', () => ({ markCodexProjectTrusted: vi.fn() }))
vi.mock('../codex/codex-real-home-hook-install', () => ({
  ensureRealHomeCodexHookState: vi.fn()
}))
vi.mock('../codex/hook-service', () => ({
  codexHookService: {
    prepareRuntimeHomeForLaunch: vi.fn().mockResolvedValue({ state: 'disabled' })
  }
}))

const codexCommand = resolveCodexCommand()
let codexAvailable = false
try {
  const probe = runProcessSync({ program: codexCommand, args: ['--version'], timeoutMs: 10000 })
  if (probe.code !== 0) {
    throw new Error(
      `Installed Codex version probe failed: code=${probe.code}, timedOut=${probe.timedOut}`
    )
  }
  codexAvailable = true
} catch (error) {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
    throw error
  }
}
// The helper fixture is a POSIX command. Native Windows binding remains
// deliberately fail-closed until its cmd.exe boundary is verified.
const itWithCodexPosix = process.platform === 'win32' || !codexAvailable ? it.skip : it

describe('native Codex managed-account MCP launch', () => {
  beforeEach(() => setupRuntimeHomeTest())

  afterEach(async () => {
    const { mainProcessState } = await import('./main-process-state')
    mainProcessState.codexRuntimeHome = null
    mainProcessState.store = null
    teardownRuntimeHomeTest()
  })

  itWithCodexPosix(
    'regenerates the helper principal before a new app-server session without config overrides',
    async () => {
      const accountId = 'native-mcp-account'
      const managedHome = createManagedAuth(
        testState.userDataDir,
        accountId,
        '{"principal":"native-mcp-account"}\n'
      )
      const helperPath = join(testState.userDataDir, 'headers.cjs')
      writeFileSync(
        helperPath,
        "const fs=require('node:fs');const i=process.argv.indexOf('--home');const a=JSON.parse(fs.readFileSync(process.argv[i+1]+'/auth.json','utf8'));process.stdout.write(JSON.stringify({'x-orca-principal':a.principal}));\n"
      )

      let observedPrincipal: string | undefined
      const server = createServer(async (request, response) => {
        observedPrincipal = request.headers['x-orca-principal'] as string | undefined
        const chunks: Buffer[] = []
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk))
        }
        const message = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          id?: string | number
          method?: string
        }
        if (message.id === undefined) {
          response.writeHead(202).end()
          return
        }
        const result =
          message.method === 'initialize'
            ? {
                protocolVersion: '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'orca-principal-fixture', version: '1' }
              }
            : message.method === 'tools/list'
              ? { tools: [] }
              : {}
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
      })
      let primaryError: unknown
      let primaryFailed = false
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error): void => {
            server.off('listening', onListening)
            reject(error)
          }
          const onListening = (): void => {
            server.off('error', onError)
            resolve()
          }
          server.once('error', onError)
          server.once('listening', onListening)
          try {
            server.listen(0, '127.0.0.1')
          } catch (error) {
            server.off('error', onError)
            server.off('listening', onListening)
            reject(error)
          }
        })
        const address = server.address()
        if (!address || typeof address === 'string') {
          throw new Error('fixture did not bind TCP')
        }

        mkdirSync(getSystemCodexHomePath(), { recursive: true })
        writeFileSync(
          join(getSystemCodexHomePath(), 'config.toml'),
          [
            '[mcp_servers.principal]',
            `url = "http://127.0.0.1:${address.port}/mcp"`,
            'required = true',
            `http_headers_helper = ${JSON.stringify(`node ${helperPath} --home ${MANAGED_CODEX_HOME_PLACEHOLDER}`)}`,
            ''
          ].join('\n')
        )
        const settings = createSettings({
          shellStartupEnvProbeSupported: true,
          codexManagedAccounts: [
            {
              id: accountId,
              email: 'fixture@example.invalid',
              managedHomePath: managedHome,
              providerAccountId: null,
              workspaceLabel: null,
              workspaceAccountId: null,
              createdAt: 1,
              updatedAt: 1,
              lastAuthenticatedAt: 1
            }
          ],
          activeCodexManagedAccountId: accountId,
          activeCodexManagedAccountIdsByRuntime: { host: accountId, wsl: {} }
        })
        const store = createStore(settings)
        const { CodexRuntimeHomeService } = await import('../codex-accounts/runtime-home-service')
        const { mainProcessState } = await import('./main-process-state')
        mainProcessState.store = store as never
        mainProcessState.codexRuntimeHome = new CodexRuntimeHomeService(store as never)
        const { prepareCodexRuntimeHomeForLaunch } = await import('./codex-launch-preparation')

        const preparedHome = await prepareCodexRuntimeHomeForLaunch(undefined, undefined, {
          launchAgent: 'codex',
          workspacePath: process.cwd()
        })
        expect(preparedHome).toBe(managedHome)
        expect(readFileSync(join(managedHome, 'config.toml'), 'utf8')).toContain(
          `--home '${managedHome}'`
        )

        const connection = await openCodexAppServerConnection({
          command: codexCommand,
          args: ['app-server'],
          env: { CODEX_HOME: preparedHome! }
        })
        try {
          await openCodexThread(connection, { cwd: process.cwd(), resumeThreadId: null }, 30_000)
          await connection.request(
            'mcpServerStatus/list',
            { cursor: null, limit: 10, threadId: null },
            { timeoutMs: 30_000 }
          )
          expect(observedPrincipal).toBe(accountId)
        } finally {
          await connection.close()
        }
      } catch (error) {
        primaryError = error
        primaryFailed = true
      }

      let cleanupError: unknown
      if (server.listening) {
        try {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()))
          })
        } catch (error) {
          cleanupError = error
        }
      }
      if (primaryFailed && cleanupError !== undefined) {
        throw new AggregateError(
          [primaryError, cleanupError],
          'Codex MCP fixture cleanup failed after the test failed'
        )
      }
      if (primaryFailed) {
        throw primaryError
      }
      if (cleanupError !== undefined) {
        throw cleanupError
      }
    },
    60_000
  )
})
