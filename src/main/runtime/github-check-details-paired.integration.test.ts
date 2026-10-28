import './rpc/unused-default-rpc-methods.test-fixture'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ProcessHostModule from '@orca/process-host'
import {
  completeFakeSpawn,
  createFakeSpawnedChild
} from '../../shared/__fixtures__/fake-spawned-child'
import { parsePairingCode } from '../../shared/pairing'
import { pairedRuntimeConnectionFromOffer } from '../../shared/paired-runtime-connection'
import { RemoteRuntimeRequestConnection } from '../../shared/remote-runtime/requests/remote-runtime-request-connection'
import type { Repo } from '../../shared/repo-types'
import type { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { RuntimeGitHubReviewQueryCommands } from './runtime-github-review-query-commands'
import { GITHUB_PULL_REQUEST_METHODS } from './rpc/methods/github-pull-request-methods'
import { clearGhAccountTokenCacheForTests } from '../github/gh-account-token'
import { clearGhCapabilityStateForTests } from '../github/gh-capability-state'
import { prCheckLogTailCache } from '../github/client/check/check-job-log-tails'
import { withPairedCheckDetailsCleanup } from './github-check-details-paired-cleanup.test-fixture'

const { spawnMock, resolverMock, detailsDelegate, captures, terminationMock } = vi.hoisted(() => {
  const signals: AbortSignal[] = []
  return {
    spawnMock: vi.fn(),
    resolverMock: vi.fn(),
    detailsDelegate: vi.fn(),
    captures: { host: 0, client: 0, signals },
    terminationMock: vi.fn()
  }
})
vi.mock('node:child_process', async (original) => ({ ...(await original()), spawn: spawnMock }))
vi.mock('../github/github-api-repository', () => ({ resolveGitHubRepoExecution: resolverMock }))
vi.mock('../github/client', async () => {
  const actual = await import('../github/client/check/get-pr-check-details')
  return {
    getPRCheckDetails: detailsDelegate.mockImplementation(actual.getPRCheckDetails),
    getPRChecks: vi.fn(),
    getPRComments: vi.fn(),
    getIssue: vi.fn()
  }
})
vi.mock('../github/work-item-details', () => ({ getPRFileContents: vi.fn() }))
vi.mock('@orca/process-host/process-tree-termination', () => ({
  signalProcessTree: terminationMock,
  forceTerminateProcessTree: terminationMock
}))
vi.mock('@orca/process-host', async (original) => {
  const actual = await original<typeof ProcessHostModule>()
  return {
    ...actual,
    runProcess: (spec: Parameters<typeof actual.runProcess>[0]) => {
      if (spec.cwd === hostFolder && spec.signal) {
        captures.signals.push(spec.signal)
      }
      return actual.runProcess(spec)
    }
  }
})
let hostFolder = ''
const children: ChildProcess[] = []
let logChild: ChildProcess | undefined

describe('paired check details over real encrypted loopback transport', () => {
  beforeEach(() => {
    children.length = 0
    logChild = undefined
    captures.host = captures.client = 0
    captures.signals.length = 0
    detailsDelegate.mockClear()
    terminationMock.mockReset().mockResolvedValue(false)
    clearGhAccountTokenCacheForTests()
    clearGhCapabilityStateForTests()
    prCheckLogTailCache.clear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it.each(['failure', 'disconnect', 'drain-failure', 'stop-failure', 'stop-stall'])(
    'executes only on the handling host and cleans up after %s',
    { timeout: 15_000 },
    async (mode) => {
      const disconnect = mode === 'disconnect' || mode === 'drain-failure'
      const directory = mkdtempSync(join(tmpdir(), 'orca-paired-check-details-'))
      hostFolder = join(directory, 'handling-host-folder')
      const repo: Repo = {
        id: 'folder',
        path: hostFolder,
        kind: 'folder',
        displayName: 'folder',
        badgeColor: 'blue',
        addedAt: 1,
        ghAccount: { host: 'github.enterprise.test', user: 'Alice' }
      }
      const resolveRepo = vi.fn(async (selector: string) => {
        if (selector !== 'id:folder') {
          throw new Error('Unknown registered folder')
        }
        return repo
      })
      const query = new RuntimeGitHubReviewQueryCommands({
        resolveRepo,
        getLocalGitArgs: (registered) => [{ ghAccount: registered.ghAccount }]
      })
      const delegate = vi.spyOn(query, 'getRepoPRCheckDetails')
      let hostSettled = false
      const runtime = {
        configureNotificationDismissalStore: () => {},
        getRuntimeId: () => 'paired-check-host',
        getStartedAt: () => 1,
        cleanupSubscriptionsForConnection: () => {},
        cancelMobileDictationForConnection: () => {},
        onClientDisconnected: () => {},
        getRepoPRCheckDetails: (...args: Parameters<typeof query.getRepoPRCheckDetails>) =>
          query.getRepoPRCheckDetails(...args).finally(() => {
            hostSettled = true
          })
      }
      resolverMock.mockImplementation(async (path, prRepo, connection, options) => {
        expect(path).toBe(hostFolder)
        expect(connection).toBeNull()
        expect(options.ghAccount).toEqual(repo.ghAccount)
        return {
          ownerRepo: prRepo,
          ghOptions: { ...options, cwd: hostFolder, host: 'github.enterprise.test', env: {} }
        }
      })
      spawnMock
        .mockReset()
        .mockImplementation((_program: string, argv: string[], options: SpawnOptions) => {
          if (options.cwd === hostFolder) {
            captures.host += 1
          } else {
            captures.client += 1
          }
          const child = createFakeSpawnedChild(800 + children.length)
          children.push(child)
          if (argv.some((arg) => arg.endsWith('/logs'))) {
            logChild = child
            return child
          }
          queueMicrotask(() =>
            completeFakeSpawn(
              child,
              argv.includes('--help')
                ? { stdout: '--user' }
                : argv[0] === 'auth'
                  ? { stdout: 'fixture-bound-token' }
                  : !disconnect
                    ? { code: 1, stderr: 'fixture-ordinary-failure' }
                    : {
                        stdout: JSON.stringify({
                          jobs: [
                            {
                              id: 77,
                              name: 'Test',
                              status: 'completed',
                              conclusion: 'failure',
                              completed_at: 'done',
                              steps: []
                            }
                          ]
                        })
                      }
            )
          )
          return child
        })
      const server = new OrcaRuntimeRpcServer({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Explicit methods and lifecycle callbacks are the entire runtime surface used by this server fixture.
        runtime: runtime as unknown as OrcaRuntimeService,
        userDataPath: directory,
        enableWebSocket: true,
        wsPort: 0,
        methods: GITHUB_PULL_REQUEST_METHODS
      })
      let connection: RemoteRuntimeRequestConnection | undefined
      const cleanupFailure = new Error('Forced paired cleanup failure')
      let childClosureAttempted = false
      let serverStopped = false
      let finishStall: () => void = () => {}
      const stalled = new Promise<void>((resolve) => {
        finishStall = resolve
      })
      const pendingCleanup = withPairedCheckDetailsCleanup(
        {
          closeClient: () => connection?.close(),
          drain: () =>
            vi.waitFor(
              () => {
                if (mode === 'drain-failure') {
                  throw cleanupFailure
                }
                expect(server.readClientActivity().openConnections).toBe(0)
              },
              { timeout: mode === 'drain-failure' ? 25 : 1_000 }
            ),
          closeChildren: async () => {
            childClosureAttempted = true
            for (const child of children) {
              child.emit('close', 0, null)
            }
            if (mode === 'stop-stall') {
              await server.stop()
              serverStopped = true
            }
          },
          stopServer: async () => {
            if (mode !== 'stop-stall') {
              await server.stop()
              serverStopped = true
            }
            if (mode === 'stop-failure') {
              throw cleanupFailure
            }
            if (mode === 'stop-stall') {
              await stalled
            }
          },
          removeDirectory: () => rmSync(directory, { recursive: true, force: true })
        },
        async () => {
          await server.start()
          const offer = server.createPairingOffer({ name: 'check-details', scope: 'runtime' })
          if (!offer.available) {
            throw new Error('Pairing unavailable')
          }
          const pairing = parsePairingCode(offer.pairingUrl)
          if (!pairing) {
            throw new Error('Invalid fixture pairing')
          }
          connection = new RemoteRuntimeRequestConnection(pairedRuntimeConnectionFromOffer(pairing))
          const caller = new AbortController()
          const pending = connection.request(
            'github.prCheckDetails',
            {
              repo: 'id:folder',
              checkRunId: !disconnect ? 9 : undefined,
              workflowRunId: disconnect ? 8 : undefined,
              prRepo: { owner: 'base', repo: 'widgets', host: 'github.enterprise.test' }
            },
            5_000,
            caller.signal
          )
          if (!disconnect) {
            await expect(pending).resolves.toMatchObject({
              ok: false,
              error: { message: 'Could not load check details.' }
            })
          } else {
            const rejection = expect(pending).rejects.toThrow()
            await vi.waitFor(() => expect(logChild).toBeDefined())
            connection.close()
            await rejection
            await vi.waitFor(() => expect(delegate.mock.calls[0][2]?.aborted).toBe(true))
            expect(captures.signals.some((signal) => signal.aborted)).toBe(true)
            expect(logChild).toBeDefined()
            logChild?.emit('close', null, 'SIGKILL')
          }
          await vi.waitFor(() => expect(hostSettled).toBe(true))
          expect(delegate).toHaveBeenCalledOnce()
          expect(detailsDelegate).toHaveBeenCalledOnce()
          expect(detailsDelegate.mock.calls[0][4]).toBe(delegate.mock.calls[0][2])
          expect(resolveRepo).toHaveBeenCalledOnce()
          expect(captures.host).toBe(disconnect ? 4 : 3)
          expect(captures.client).toBe(0)
          expect(captures.signals).toHaveLength(disconnect ? 2 : 1)
          const apiCalls = spawnMock.mock.calls.filter((call) => call[1][0] === 'api')
          expect(apiCalls).toHaveLength(disconnect ? 2 : 1)
          for (const call of apiCalls) {
            expect(call[1]).toContain('github.enterprise.test')
            expect(call[2].cwd).toBe(hostFolder)
            expect(call[2].env.GH_ENTERPRISE_TOKEN).toBe('fixture-bound-token')
          }
          expect(prCheckLogTailCache.size).toBe(0)
        },
        mode === 'stop-stall' ? 100 : 2_000
      )
      try {
        if (mode === 'drain-failure' || mode === 'stop-failure') {
          await expect(pendingCleanup).rejects.toBe(cleanupFailure)
        } else if (mode === 'stop-stall') {
          await expect(pendingCleanup).rejects.toThrow('Paired check server stop timed out')
        } else {
          await pendingCleanup
        }
      } finally {
        finishStall()
      }
      expect(childClosureAttempted).toBe(true)
      expect(serverStopped).toBe(true)
      expect(server.readClientActivity().openConnections).toBe(0)
      expect(existsSync(directory)).toBe(false)
    }
  )
})
