import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as compatibilityEvidence from '../shared/orchestration-compatibility-evidence'
import * as nativeHosts from '../shared/folder-workspace-execution-host'
import * as workspaceSelection from './caller-host-worktree-selection'
import { reportCliError } from './cli-error'
import { main } from './index'
import { buildWorktree, okFixture, worktreeListFixture } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

// Count only choice structures; spies call the actual reporter, recursive redactor and serializer.
function traceChoiceReporting() {
  const stringify = JSON.stringify
  const entries = Object.entries
  const metrics = {
    propertyVisits: 0,
    redactions: 0,
    serializations: 0,
    serializedBytes: 0,
    inputCodeUnits: 0,
    choices: 0,
    forms: 0
  }
  const objectEntries = vi.spyOn(Object, 'entries').mockImplementation((value) => {
    const result = entries(value)
    if (value && typeof value === 'object' && 'selector' in value && 'path' in value) {
      metrics.propertyVisits += result.length
    }
    return result
  })
  const originalRedact = compatibilityEvidence.redactOrchestrationCompatibilitySecrets
  const redactor = vi
    .spyOn(compatibilityEvidence, 'redactOrchestrationCompatibilitySecrets')
    .mockImplementation((value) => {
      if (
        value &&
        typeof value === 'object' &&
        'workspaces' in value &&
        'validSelectorForms' in value
      ) {
        metrics.redactions++
        if (Array.isArray(value.workspaces)) {
          metrics.choices += value.workspaces.length
        }
        if (Array.isArray(value.validSelectorForms)) {
          metrics.forms += value.validSelectorForms.length
        }
      }
      return originalRedact(value)
    })
  const serialization = vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
    const result = stringify(value, replacer, space)
    if (
      value &&
      typeof value === 'object' &&
      (('error' in value && value.error?.code === 'selector_ambiguous') ||
        (Array.isArray(value) &&
          value[0] &&
          typeof value[0] === 'object' &&
          'selector' in value[0]))
    ) {
      const stringUnits = (input: unknown): number =>
        typeof input === 'string'
          ? input.length
          : Array.isArray(input)
            ? input.reduce((n, entry) => n + stringUnits(entry), 0)
            : input && typeof input === 'object'
              ? entries(input).reduce((n, [key, entry]) => n + key.length + stringUnits(entry), 0)
              : 0
      metrics.inputCodeUnits += stringUnits(value)
      metrics.serializations++
      metrics.serializedBytes += Buffer.byteLength(result ?? '')
    }
    return result
  })
  return {
    metrics,
    stop: () => {
      serialization.mockRestore()
      redactor.mockRestore()
      objectEntries.mockRestore()
    }
  }
}

describe('cwd workspace owner election and reporting at N and 10N', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })
  beforeEach(() => {
    vi.stubEnv('ORCA_AGENT_SESSION_ID', undefined)
    vi.stubEnv('ORCA_STRUCTURED_SESSION', undefined)
  })
  afterEach(() => vi.unstubAllEnvs())
  const root = buildWorktree('/tmp/owner-choice', 'main', 'abc', 'repo-a')
  it.each([
    { caller: false, json: false },
    { caller: false, json: true },
    { caller: true, json: true }
  ])(
    'bounds real-main owner/identity/diagnostic work at N and 10N (%j)',
    async ({ caller, json }) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const prior = process.exitCode
      const samples: number[] = []
      const serialized: number[] = []
      const timings: {
        count: number
        elapsedMs: number
        operations: number
        outputBytes: number
        reporting: ReturnType<typeof traceChoiceReporting>['metrics']
      }[] = []
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        for (const count of [1_000, 10_000]) {
          let operations = 0
          const rows = Array.from({ length: count }, (_, index) => {
            const owner = index % (count / 2)
            const host = index < count / 2 ? 'local' : 'ssh:other'
            return {
              ...root,
              get id() {
                operations++
                return `${root.id}::workspace:${owner}`
              },
              get repoId() {
                operations++
                return root.repoId
              },
              get path() {
                operations++
                return root.path
              },
              get hostId() {
                operations++
                return host
              },
              get identity() {
                operations++
                return {
                  get key() {
                    operations++
                    return `${host}:owner-${owner}`
                  }
                }
              }
            }
          })
          if (caller) {
            process.env.ORCA_WORKTREE_ID = `${root.id}::workspace:0`
          } else {
            delete process.env.ORCA_WORKTREE_ID
          }
          callMock.mockReset()
          log.mockClear()
          process.exitCode = prior
          callMock.mockImplementation(async (method) =>
            method === 'worktree.list'
              ? worktreeListFixture(rows)
              : okFixture('show', { worktree: root })
          )
          errors.mockClear()
          const trace = traceChoiceReporting()
          let elapsedMs = 0
          try {
            const started = performance.now()
            await main(['worktree', 'current', ...(json ? ['--json'] : [])], root.path)
            elapsedMs = performance.now() - started
          } finally {
            trace.stop()
          }
          const measured = operations
          expect(measured).toBeGreaterThanOrEqual(count)
          expect(measured).toBeLessThanOrEqual(50 * count)
          expect(callMock.mock.calls.filter(([method]) => method === 'worktree.list')).toEqual([
            ['worktree.list', { limit: 10_000 }]
          ])
          const printed = (json ? log : errors).mock.calls.flat().join('\n')
          const output = json
            ? JSON.parse(printed)
            : {
                error: {
                  data: {
                    workspaces: JSON.parse(
                      printed
                        .split('Workspace choices (JSON data):\n')[1]!
                        .split('\nNext step:')[0]!
                    ),
                    validSelectorForms: [],
                    nextSteps: printed.split('Next step:').slice(1)
                  }
                }
              }
          if (!json) {
            output.error.data.validSelectorForms = output.error.data.workspaces.map(
              (choice: { selector: string }) => choice.selector
            )
          }
          if (caller) {
            expect(process.exitCode).toBe(prior)
            expect(callMock).toHaveBeenCalledWith('worktree.show', {
              worktree: 'identity:local:owner-0'
            })
            expect(output.result.worktree.id).toBe(root.id)
          } else {
            expect(process.exitCode).toBe(1)
            expect(output.error.data.workspaces).toHaveLength(count / 2)
            expect(output.error.data.validSelectorForms).toHaveLength(count / 2)
            expect(output.error.data.validSelectorForms[0]).toBe('identity:local:owner-0')
            expect(output.error.data.nextSteps).toHaveLength(3)
            expect(callMock).toHaveBeenCalledTimes(1)
            expect(printed.split('More than one Orca workspace')).toHaveLength(2)
            if (!json) {
              expect(printed.split('Workspace choices (JSON data):')).toHaveLength(2)
            }
            expect(trace.metrics).toMatchObject({
              redactions: 1,
              choices: count / 2,
              forms: count / 2,
              serializations: 1
            })
            expect(trace.metrics.propertyVisits).toBeGreaterThanOrEqual((4 * count) / 2)
            expect(trace.metrics.propertyVisits).toBeLessThanOrEqual((8 * count) / 2)
            const rawBytes = Buffer.byteLength(JSON.stringify(output.error.data.workspaces))
            expect(trace.metrics.serializedBytes).toBeGreaterThanOrEqual(rawBytes)
            expect(trace.metrics.serializedBytes).toBeLessThanOrEqual(6 * rawBytes + 4096)
            expect(trace.metrics.inputCodeUnits).toBeGreaterThan(0)
            expect(trace.metrics.serializedBytes).toBeLessThanOrEqual(
              6 * trace.metrics.inputCodeUnits + 32 * count + 4096
            )
            serialized.push(trace.metrics.serializedBytes)
          }
          timings.push({
            count,
            elapsedMs,
            operations: measured,
            outputBytes: Buffer.byteLength(printed),
            reporting: { ...trace.metrics }
          })
          samples.push(measured)
        }
        expect(samples[1]!).toBeLessThanOrEqual(11 * samples[0]!)
        if (!caller) {
          expect(serialized[1]!).toBeLessThanOrEqual(11 * serialized[0]!)
        }
        console.info(
          'immediate-cwd-benchmark',
          JSON.stringify({
            platform: process.platform,
            node: process.version,
            base: '3bfcda1bf043af8d83371b2f131a65f2056f7970',
            sourceInputSha256: createHash('sha256').update(readFileSync(__filename)).digest('hex'),
            format: json ? 'json' : 'text',
            caller,
            samplesPerPopulation: 1,
            boundary:
              'real CLI main(current), election and reporter with call-through counters; fresh corpus and reset client/output per N before timing; modules already loaded, N first trigger then 10N warm modules; no cold-process sample; corpus setup and assertions excluded',
            samples: timings
          })
        )
      } finally {
        process.exitCode = prior
      }
    }
  )

  it.each([false, true])(
    'measures native presence, eligible caller/full election and added reporting (caller=%s)',
    async (caller) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const resolveHost = vi.spyOn(nativeHosts, 'resolveFolderWorkspaceHost')
      const elect = workspaceSelection.selectEnclosingWorktreeOnHost
      const presence = workspaceSelection.hasEnclosingWorktreeOnHost
      const samples: {
        count: number
        nativeMs: number
        addedMs: number
        baselineFolderReads: number
        hostCalls: number
        addedReads: number
        presenceReads: number
        serializations: number
        bytes: number
      }[] = []
      const prior = process.exitCode
      try {
        for (const count of [1000, 10000]) {
          let baselineFolderReads = 0
          let addedReads = 0
          let presenceReads = 0
          const folders = Array.from({ length: count }, (_, index) => ({
            get id() {
              baselineFolderReads++
              return `native-${index}`
            },
            get folderPath() {
              baselineFolderReads++
              return root.path
            },
            projectGroupId: index % 2 === 0 ? 'local' : 'remote'
          }))
          const observe = <Row extends object>(rows: readonly Row[], visit: () => void) =>
            rows.map(
              (row) =>
                new Proxy(row, {
                  get(target, key, receiver) {
                    visit()
                    // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: only Reflect.get forwards a raw string|symbol key with the proxy receiver.
                    return Reflect.get(target, key, receiver)
                  }
                })
            )
          let eligible: Parameters<typeof elect>[0] = []
          const selection = vi
            .spyOn(workspaceSelection, 'selectEnclosingWorktreeOnHost')
            .mockImplementation((rows, ...args) => {
              if (rows.length > eligible.length) {
                eligible = rows
              }
              return elect(
                observe(rows, () => {
                  addedReads++
                }),
                ...args
              )
            })
          const present = vi
            .spyOn(workspaceSelection, 'hasEnclosingWorktreeOnHost')
            .mockImplementation((rows, ...args) =>
              presence(
                observe(rows, () => {
                  presenceReads++
                }),
                ...args
              )
            )
          if (caller) {
            process.env.ORCA_WORKSPACE_ID = 'folder:native-0'
          } else {
            delete process.env.ORCA_WORKSPACE_ID
          }
          callMock.mockReset()
          log.mockClear()
          error.mockClear()
          resolveHost.mockClear()
          process.exitCode = prior
          callMock.mockImplementation(async (method) => {
            if (method === 'folderWorkspace.list') {
              return okFixture('folders', { folderWorkspaces: folders })
            }
            if (method === 'projectGroup.list') {
              return okFixture('groups', {
                groups: [{ id: 'local' }, { id: 'remote', connectionId: 'other' }]
              })
            }
            if (method === 'repo.list') {
              return okFixture('repos', { repos: [] })
            }
            if (method === 'workspacePorts.scanHost') {
              return okFixture('ports', { ports: [] })
            }
            throw new Error(`unexpected native scale RPC ${method}`)
          })
          const started = performance.now()
          await main(['ports', '--all', '--json'], root.path)
          const nativeMs = performance.now() - started
          expect(resolveHost).toHaveBeenCalledTimes(count)
          expect(present).toHaveBeenCalledTimes(1)
          expect(selection).toHaveBeenCalledTimes(caller ? 1 : 2)
          expect(presenceReads).toBeLessThanOrEqual(10 * count)
          expect(addedReads).toBeLessThanOrEqual(50 * count)
          expect(callMock.mock.calls.map(([method]) => method)).toEqual([
            'folderWorkspace.list',
            'projectGroup.list',
            'repo.list',
            ...(caller ? ['workspacePorts.scanHost'] : [])
          ])
          if (caller) {
            expect(process.exitCode).toBe(prior)
            expect(callMock).toHaveBeenLastCalledWith('workspacePorts.scanHost', {
              worktree: 'id:folder:native-0'
            })
            expect(JSON.parse(log.mock.calls.flat().join('\n')).result.ports).toEqual([])
          } else {
            expect(process.exitCode).toBe(1)
            expect(eligible).toHaveLength(count / 2)
            expect(JSON.parse(log.mock.calls.flat().join('\n')).error.data.workspaces).toHaveLength(
              count / 2
            )
          }
          selection.mockRestore()
          present.mockRestore()
          // Isolate added election/reporting on the actual native entry's supplied population.
          addedReads = 0
          log.mockClear()
          error.mockClear()
          const trace = traceChoiceReporting()
          const addedStarted = performance.now()
          try {
            try {
              elect(
                observe(eligible, () => {
                  addedReads++
                }),
                root.path,
                'local',
                'ports'
              )
            } catch (failure) {
              reportCliError(failure, false)
            }
          } finally {
            trace.stop()
          }
          const addedMs = performance.now() - addedStarted
          expect(addedReads).toBeLessThanOrEqual(50 * count)
          if (!caller) {
            expect(trace.metrics).toMatchObject({
              choices: count / 2,
              forms: count / 2,
              redactions: 1,
              serializations: 1
            })
            expect(trace.metrics.propertyVisits).toBeLessThanOrEqual((8 * count) / 2)
            expect(
              error.mock.calls.flat().join('\n').split('Workspace choices (JSON data):')
            ).toHaveLength(2)
          }
          samples.push({
            count,
            nativeMs,
            addedMs,
            baselineFolderReads,
            hostCalls: resolveHost.mock.calls.length,
            addedReads,
            presenceReads,
            serializations: trace.metrics.serializations,
            bytes: trace.metrics.serializedBytes
          })
        }
        expect(samples[1]!.addedReads).toBeLessThanOrEqual(11 * samples[0]!.addedReads)
        expect(samples[1]!.presenceReads).toBeLessThanOrEqual(11 * samples[0]!.presenceReads)
        console.info(
          'native-cwd-benchmark',
          JSON.stringify({
            platform: process.platform,
            node: process.version,
            caller,
            base: '3bfcda1bf043af8d83371b2f131a65f2056f7970',
            boundary:
              'real native entry includes existing per-folder F/G/R scans, possibly quadratic; added election/reporter timed separately; each N uses fresh corpus, modules already loaded',
            samples
          })
        )
      } finally {
        process.exitCode = prior
      }
    }
  )
})
