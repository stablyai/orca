import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { spawnProcess } from '@orca/process-host'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { expect, it, vi } from 'vitest'
import { openClaudeStreamJsonConnection } from '../claude/claude-stream-json-connection'
import { POSIX_PROVIDER_SUPERVISOR_SCRIPT } from '../provider-process/provider-process-supervisor'
import { PROVIDER_SPAWN_FAILURE_MARKER } from '../provider-process/provider-spawn-failure-report'
import type * as SourceCompletion from '../provider-process/provider-source-completion'
import type * as InitProof from '../claude/structured/claude-structured-init-proof'
import { providerExecutableMissing } from '../provider-process/provider-executable-missing'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime,
  waitForStructuredAgentSessionRecovery
} from './structured-agent-session-runtime'
import {
  createTestParams,
  CREATE_TEST_CALLER as CALLER
} from '../native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import {
  hostTestMessage,
  hostTestOperationId,
  HOST_TEST_SESSION as SESSION
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'

const trace = vi.hoisted(() => {
  let rows: {
    sequence: number
    event: string
    observation: string
    identity: unknown
    detail: unknown
  }[] = []
  const waiters = new Map<string, Set<() => void>>()
  let signal: AbortSignal
  let deadline = 0
  function errorJson(_key: string, value: unknown): unknown {
    return value instanceof Error
      ? {
          ...value,
          name: value.name,
          message: value.message,
          stack: value.stack,
          cause: value.cause,
          ...(value instanceof AggregateError ? { errors: value.errors } : {})
        }
      : value
  }
  return {
    errorJson,
    identity: (): unknown => null,
    sourceDone: () => {},
    reset() {
      rows = []
      waiters.clear()
      signal = AbortSignal.timeout(20_000)
      // ast-grep-ignore: test-no-wall-clock -- Real-time budget only fails inconclusive/hung actual SDK/OS joins; never proves success, ordering or physical exit.
      deadline = Date.now() + 20_000
      this.identity = () => null
      this.sourceDone = () => {}
    },
    fact(event: string, detail: unknown = null, observation = 'synchronous') {
      // Observation cannot change the original callback/promise's outcome.
      try {
        rows.push(
          JSON.parse(
            JSON.stringify(
              { sequence: rows.length + 1, event, observation, identity: this.identity(), detail },
              errorJson
            )
          )
        )
        for (const done of waiters.get(event) ?? []) {
          done()
        }
        waiters.delete(event)
      } catch (error) {
        rows.push({
          sequence: rows.length + 1,
          event: 'observer-error',
          observation,
          identity: null,
          detail: String(error)
        })
      }
    },
    observe<T>(
      promise: Promise<T>,
      event: string,
      settled?: (error?: unknown) => void
    ): Promise<T> {
      void promise.then(
        (value) => {
          this.fact(`${event}-resolved`, value, 'promise-reaction')
          try {
            settled?.()
          } catch (error) {
            this.fact('observer-error', error)
          }
        },
        (error) => {
          this.fact(`${event}-rejected`, error, 'promise-reaction')
          try {
            settled?.(error)
          } catch (failure) {
            this.fact('observer-error', failure)
          }
        }
      )
      return promise
    },
    // ast-grep-ignore: test-no-wall-clock -- Real-time budget only fails inconclusive/hung actual SDK/OS joins; never proves success, ordering or physical exit.
    remainingBudget: () => Math.max(0, deadline - Date.now()),
    snapshot: () => rows,
    async when(event: string) {
      if (rows.some((row) => row.event === event)) {
        return
      }
      signal.throwIfAborted()
      await new Promise<void>((resolveWait, reject) => {
        const aborted = () => {
          waiters.get(event)?.delete(done)
          reject(new Error(`INCONCLUSIVE: no ${event} before safety budget`))
        }
        const done = () => {
          signal.removeEventListener('abort', aborted)
          resolveWait()
        }
        const set = waiters.get(event) ?? new Set<() => void>()
        set.add(done)
        waiters.set(event, set)
        signal.addEventListener('abort', aborted, { once: true })
      })
    }
  }
})

vi.mock('../provider-process/provider-source-completion', async (importOriginal) => {
  const actual = await importOriginal<typeof SourceCompletion>()
  return {
    ...actual,
    createProviderSourceCompletion: (
      ...args: Parameters<typeof actual.createProviderSourceCompletion>
    ) => {
      const source = actual.createProviderSourceCompletion(...args)
      trace.observe(source.done, 'source', () => {
        trace.sourceDone()
      })
      return source
    }
  }
})
vi.mock('../claude/structured/claude-structured-init-proof', async (importOriginal) => {
  const actual = await importOriginal<typeof InitProof>()
  return {
    ...actual,
    createClaudeInitProof: () => {
      const proof = actual.createClaudeInitProof()
      const reject = proof.reject.bind(proof)
      vi.spyOn(proof, 'reject').mockImplementation((error) => {
        trace.fact('init-proof-reject-called', { error, missing: providerExecutableMissing(error) })
        return reject(error)
      })
      const seen = proof.seen.bind(proof)
      vi.spyOn(proof, 'seen').mockImplementation(() => {
        try {
          const value = seen()
          trace.fact('init-proof-seen', value)
          return value
        } catch (error) {
          trace.fact('init-proof-seen-threw', error)
          throw error
        }
      })
      trace.observe(proof.promise, 'init-proof')
      return proof
    }
  }
})

// The controlled input closes real fd1 before evaluating the exact production supervisor.
function gatedSupervisor(): string {
  return `
    const fs = require('node:fs')
    let started = false
    let closedOutput = false
    let pending = ''
    const stdin = (chunk) => {
      pending += chunk.toString()
      for (let boundary; (boundary = pending.indexOf('\\n')) !== -1;) {
        const frame = JSON.parse(pending.slice(0, boundary))
        pending = pending.slice(boundary + 1)
        if (frame.type === 'control_request' && frame.request.subtype === 'initialize')
          process.send({ experiment: 'initialize-wire-seen', requestId: frame.request_id })
      }
    }
    process.stdin.on('data', stdin)
    const run = () => {
      if (started) return
      started = true
      clearTimeout(safety)
      process.stdin.off('data', stdin)
      process.off('message', command)
      eval(${JSON.stringify(POSIX_PROVIDER_SUPERVISOR_SCRIPT)})
    }
    const command = (message) => {
      if (message && message.experiment === 'eof' && !closedOutput) {
        closedOutput = true
        fs.closeSync(1)
      }
      if (message && message.experiment === 'run') run()
    }
    process.on('message', command)
    const safety = setTimeout(() => {
      fs.writeSync(2, 'STARTUP ORDERING SAFETY RELEASE\\n')
      run()
    }, 10000)
    process.send({ experiment: 'gate-ready' })
  `
}

function procStartTicks(pid: number | undefined): string | null {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
    return null
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const ticks = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19]
    return ticks && /^\d+$/u.test(ticks) ? ticks : null
  } catch {
    return null
  }
}

async function bounded<T>(
  promise: Promise<T>,
  label: string,
  ms = trace.remainingBudget()
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`INCONCLUSIVE: ${label} did not join`)), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

for (const lifecycle of ['external', 'default'] as const) {
  for (const input of ['natural-missing', 'eof-before-missing'] as const) {
    it.skipIf(process.platform !== 'linux')(
      `${lifecycle}: ${input === 'natural-missing' ? 'missing CLI regression' : 'controlled EOF diagnostic capture'}`,
      async () => {
        trace.reset()
        const output = resolve(
          process.env.ORCA_CLAUDE_STARTUP_TRACE_DIR ?? 'ci-shards/claude-startup-ordering'
        )
        mkdirSync(output, { recursive: true })
        const receipt = join(output, `${lifecycle}-${input}.json`)
        let host: Awaited<ReturnType<typeof ensureStructuredAgentSessionHost>> | undefined
        let directory: string | undefined
        let raw: ReturnType<PipedProcessSpawner> | undefined
        let connection: Awaited<ReturnType<typeof openClaudeStreamJsonConnection>> | undefined
        let rawClosed: Promise<void> | undefined
        let attempt: {
          ordinal: number
          sessionId: string
          fence: number
          acquisitionGeneration: string
        } | null = null
        let spawnCount = 0,
          queryCount = 0,
          acquireCount = 0
        let startTicks: string | null = null
        let initializePending = false
        let running = input === 'natural-missing'
        let firstFailure: AgentJournalRenderItem | undefined
        let unsubscribe: (() => void) | undefined
        let failure: unknown
        let teardownJoined = false
        const failures: unknown[] = []
        trace.identity = () => ({
          attempt,
          pid: raw?.pid ?? null,
          startTicks,
          child: (() => {
            const child = host?.collaboratorsForTests().sessions.get(SESSION)?.child
            return child
              ? {
                  generation: child.generation,
                  fence: child.fence,
                  phase: child.phase,
                  startedFor: child.startedFor
                }
              : null
          })(),
          lease: host?.deps.store.getRecord(SESSION)?.lease ?? null
        })
        const persist = (phase: string) => {
          writeFileSync(
            receipt,
            JSON.stringify(
              {
                lifecycle,
                input,
                phase,
                failure,
                failures,
                teardownJoined,
                rows: trace.snapshot()
              },
              trace.errorJson,
              2
            )
          )
        }
        const releaseMissing = () => {
          if (!running && raw?.connected && raw.send) {
            running = true
            trace.fact('release-real-missing-spawn')
            try {
              raw.send({ experiment: 'run' })
            } catch (error) {
              trace.fact('release-failed', error)
            }
          }
        }
        trace.fact('case-start', {
          platform: process.platform,
          comparison: 'patched SDK default/current facade, not main',
          interpretation:
            input === 'natural-missing'
              ? 'requires missing-CLI classification'
              : 'capture only; not product correctness'
        })
        persist('before-setup')
        try {
          const cwd = await mkdtemp(join(tmpdir(), 'claude-startup-ordering-'))
          directory = cwd
          mkdirSync(join(cwd, 'claude-home'))
          const missing = join(cwd, 'missing-claude')
          expect(existsSync(missing)).toBe(false)
          const spawn: PipedProcessSpawner = (spec) => {
            spawnCount += 1
            expect(spec.program).toBe(process.execPath)
            expect(spec.args?.[0]).toBe('-e')
            expect(spec.args?.[1]).toBe(POSIX_PROVIDER_SUPERVISOR_SCRIPT)
            const args = [...(spec.args ?? [])]
            if (input === 'eof-before-missing') {
              args[1] = gatedSupervisor()
            }
            const child = spawnProcess({ ...spec, args })
            raw = child
            const write = child.stdin.write.bind(child.stdin)
            vi.spyOn(child.stdin, 'write').mockImplementation(
              (
                chunk: string | Uint8Array,
                encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
                callback?: (error?: Error | null) => void
              ) => {
                const bytes =
                  typeof chunk === 'string'
                    ? Buffer.from(
                        chunk,
                        typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined
                      )
                    : chunk
                trace.fact('stdin-write-call', {
                  bytes: bytes.length,
                  sha256: createHash('sha256').update(bytes).digest('hex')
                })
                if (typeof encodingOrCallback === 'function') {
                  return write(chunk, encodingOrCallback)
                }
                if (encodingOrCallback === undefined) {
                  return write(chunk, callback)
                }
                return write(chunk, encodingOrCallback, callback)
              }
            )
            startTicks = procStartTicks(child.pid)
            trace.fact('actual-child-created', { pid: child.pid, startTicks, spawnCount })
            rawClosed = new Promise((resolveClose) =>
              child.once('close', (code, signal) => {
                trace.fact('raw-close', { code, signal })
                resolveClose()
              })
            )
            child.on('message', (message: unknown) => {
              if (
                message &&
                typeof message === 'object' &&
                'experiment' in message &&
                typeof message.experiment === 'string'
              ) {
                trace.fact(message.experiment, message)
              }
            })
            child.stdout.once('end', () => trace.fact('raw-stdout-eof', { initializePending }))
            child.stderr.on('data', (bytes) => trace.fact('raw-stderr', String(bytes)))
            child.once('exit', (code, signal) =>
              trace.fact('raw-root-exit', { code, signal, initializePending })
            )
            child.once('error', (error) => trace.fact('raw-spawn-error', error))
            return child
          }
          const sdk: typeof query = ({ prompt, options }) => {
            queryCount += 1
            const { processReceiveLifecycle: _external, ...ordinaryOptions } = options ?? {}
            const session = query({
              prompt,
              options: lifecycle === 'external' ? options : ordinaryOptions
            })
            trace.fact('actual-sdk-query', { lifecycle, queryCount })
            if (!(session.receiveCompleted instanceof Promise)) {
              throw new Error('SDK PATCH NOT MATERIALIZED')
            }
            trace.observe(session.receiveCompleted, 'sdk-public-receive', () => {
              trace.fact('sdk-public-receive-settled', null, 'promise-reaction')
            })
            const initialize = session.initializationResult.bind(session)
            vi.spyOn(session, 'initializationResult').mockImplementation(() => {
              initializePending = true
              trace.fact('sdk-initialize-called')
              return trace.observe(initialize(), 'sdk-initialize', (error) => {
                initializePending = false
                trace.fact(
                  'initialize-settled-physical-sample',
                  connection?.exitVerdict,
                  'promise-reaction'
                )
                if (
                  error !== undefined &&
                  input === 'eof-before-missing' &&
                  lifecycle === 'external'
                ) {
                  releaseMissing()
                }
              })
            })
            const next = session.next.bind(session)
            vi.spyOn(session, 'next').mockImplementation((...args) => {
              trace.fact('sdk-public-next-called')
              return trace.observe(next(...args), 'sdk-public-next', () => {
                trace.fact('sdk-public-next-settled', null, 'promise-reaction')
              })
            })
            const close = session.close.bind(session)
            vi.spyOn(session, 'close').mockImplementation(() => {
              trace.fact('sdk-public-close-called')
              return close()
            })
            return session
          }
          const log = (_message: string, context: { scope?: string; [key: string]: unknown }) => {
            trace.fact(context.scope ?? 'host-log', context)
          }
          persist('before-host-setup')
          host = await bounded(
            ensureStructuredAgentSessionHost({
              stateDirectory: directory,
              hostId: 'local',
              claimKeyId: 'startup-ordering',
              logger: { warn: log, error: log },
              resolveWorkspacePath: async () => cwd,
              resolveEnvironment: async () => ({ PATH: '/usr/bin:/bin' }),
              resolveClaudeCommand: () => ({ command: missing, prefixArgs: [] }),
              resolveLaunchArgs: () => [],
              resolveClaudeAuthPolicy: () => ({ account: 'system' }),
              openClaudeConnection: (launch, handlers) => {
                const opening = openClaudeStreamJsonConnection(
                  launch,
                  {
                    ...handlers,
                    onFault: (error) => {
                      trace.fact('connection-fault', {
                        error,
                        missing: providerExecutableMissing(error)
                      })
                      handlers?.onFault?.(error)
                    },
                    onExit: (error, exit) => {
                      trace.fact('connection-root-report', {
                        error,
                        exit,
                        missing: providerExecutableMissing(error)
                      })
                      handlers?.onExit?.(error, exit)
                    }
                  },
                  spawn,
                  sdk
                )
                void opening.then(
                  (opened) => {
                    connection = opened
                    trace.fact('connection-open-resolved', null, 'promise-reaction')
                  },
                  (error) => {
                    trace.fact('connection-open-rejected', error, 'promise-reaction')
                  }
                )
                return opening
              }
            }),
            'host setup'
          )
          const open = host.deps.adapter.open.bind(host.deps.adapter)
          vi.spyOn(host.deps.adapter, 'open').mockImplementation((params) => {
            acquireCount += 1
            attempt = {
              ordinal: acquireCount,
              sessionId: params.sessionId,
              fence: params.fence,
              acquisitionGeneration: params.acquisitionGeneration
            }
            trace.fact('adapter-open-called', params)
            return trace.observe(open(params), 'adapter-open')
          })
          trace.sourceDone = () => {
            trace.fact(
              'source-settled-pending-initialize',
              { initializePending },
              'promise-reaction'
            )
            if (input === 'eof-before-missing' && lifecycle === 'default') {
              releaseMissing()
            }
          }
          persist('before-create-admission')
          const created = await bounded(
            host.create(
              CALLER,
              createTestParams(undefined, {
                provider: 'claude',
                agent: 'claude',
                accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(directory, 'claude-home') }
              })
            ),
            'create admission'
          )
          trace.fact('host-create-admitted', created, 'await-continuation')
          expect(created).toMatchObject({ ok: true })
          expect(acquireCount).toBe(0)
          persist('before-subscribe')
          unsubscribe = await bounded(
            host.subscribe({
              id: 'startup-ordering-observer',
              sessionId: SESSION,
              emit: (frame) => {
                const items =
                  frame.type === 'snapshot' || frame.type === 'reset'
                    ? frame.page.items
                    : frame.type === 'batch'
                      ? frame.batch.items
                      : []
                for (const item of items) {
                  if (item.body?.kind === 'status' && item.body.failure && !firstFailure) {
                    firstFailure = item
                    trace.fact('first-subscribed-persisted-failure', item)
                  }
                }
              }
            }),
            'subscribe'
          )
          trace.fact('host-subscribed')
          const body = hostTestMessage('hello')
          const operationId = hostTestOperationId()
          trace.fact('host-send-issued', { operationId, body })
          persist('before-send-admission')
          const sent = await bounded(
            host.send(CALLER, {
              body,
              envelope: {
                sessionId: SESSION,
                clientOperationId: operationId,
                expectedRuntimeFence: null,
                payloadFingerprint: computeAgentSessionPayloadFingerprint({
                  method: 'agentSession.send',
                  sessionId: SESSION,
                  fields: { body }
                })
              }
            }),
            'send admission'
          )
          trace.fact('host-send-admitted-not-dispatch-settlement', sent, 'await-continuation')
          expect(sent).toMatchObject({ ok: true })
          persist('before-input-barriers')
          if (input === 'eof-before-missing') {
            await trace.when('gate-ready')
            await trace.when('sdk-initialize-called')
            await trace.when('initialize-wire-seen')
            trace.fact('request-real-stdout-eof', {
              initializePending,
              physical: connection?.exitVerdict
            })
            expect(initializePending).toBe(true)
            if (!raw?.send) {
              throw new Error('INCONCLUSIVE: no actual child IPC')
            }
            raw.send({ experiment: 'eof' })
          }
          persist('before-first-failure')
          await trace.when('first-subscribed-persisted-failure')
          persist('first-failure-before-joins')
          await bounded(rawClosed ?? Promise.reject(new Error('no owned child')), 'raw close')
          await trace.when('sdk-public-receive-settled')
          await trace.when('sdk-public-next-settled')
          persist('before-host-settlement')
          await bounded(
            host.collaboratorsForTests().serialize(SESSION, async () => {}),
            'host settlement'
          )
          await bounded(waitForStructuredAgentSessionRecovery(), 'recovery')
          const snapshot = await bounded(host.journalSnapshot(SESSION), 'persisted snapshot')
          trace.fact('host-persisted-snapshot', snapshot, 'await-continuation')
          trace.fact('final-physical', {
            verdict: connection?.exitVerdict,
            missing: connection?.executableMissing,
            exitCode: raw?.exitCode,
            signalCode: raw?.signalCode
          })
          persist('settled-before-assertions')
          expect(acquireCount).toBe(1)
          expect(spawnCount).toBe(1)
          expect(queryCount).toBe(1)
          expect(raw?.pid).toBeGreaterThan(0)
          expect(startTicks, 'INCONCLUSIVE: unknown actual /proc start identity').not.toBeNull()
          const rows = trace.snapshot()
          const first = rows.find((row) => row.event === 'first-subscribed-persisted-failure')
          expect(first?.identity).toMatchObject({
            attempt: {
              ordinal: 1,
              sessionId: SESSION,
              fence: expect.any(Number),
              acquisitionGeneration: expect.any(String)
            },
            pid: raw?.pid,
            startTicks
          })
          expect(first?.identity).toMatchObject({ attempt, pid: raw?.pid, startTicks })
          for (const row of rows.slice(
            rows.findIndex((row) => row.event === 'actual-child-created')
          )) {
            expect(row.identity, `identity at ${row.event}`).toMatchObject({
              attempt,
              pid: raw?.pid,
              startTicks
            })
          }
          expect(rows.some((row) => row.event === 'stdin-write-call')).toBe(true)
          expect(snapshot.items.find((item) => item.itemId === firstFailure?.itemId)).toEqual(
            firstFailure
          )
          expect(rows.some((row) => row.event === 'observer-error')).toBe(false)
          expect(
            rows.some(
              (row) => row.event === 'raw-stderr' && String(row.detail).includes('SAFETY RELEASE')
            )
          ).toBe(false)
          expect(
            rows.some(
              (row) =>
                row.event === 'raw-stderr' &&
                String(row.detail).includes(PROVIDER_SPAWN_FAILURE_MARKER)
            )
          ).toBe(true)
          expect(rows.find((row) => row.event === 'raw-root-exit')?.detail).toMatchObject({
            code: 127,
            signal: null
          })
          if (input === 'natural-missing') {
            expect(
              JSON.stringify(firstFailure),
              'natural missing executable must retain the missing-CLI diagnosis'
            ).toMatch(/cliMissing|ENOENT/u)
          } else {
            // This validates the injected ordering, not the product's resulting failure classification.
            const eof = rows.findIndex((row) => row.event === 'raw-stdout-eof')
            expect(eof).toBeGreaterThan(-1)
            expect(
              rows.findIndex((row) => row.event === 'release-real-missing-spawn')
            ).toBeGreaterThan(eof)
            expect(rows.findIndex((row) => row.event === 'raw-root-exit')).toBeGreaterThan(eof)
          }
        } catch (error) {
          failure = error
          failures.push(error)
          trace.fact('case-failed', error)
          persist('failed-before-cleanup')
        } finally {
          releaseMissing()
          unsubscribe?.()
          trace.fact('cleanup-start', { initializePending })
          persist('partial-before-cleanup-joins')
          try {
            await bounded(stopStructuredAgentSessionRuntime(), 'host teardown', 20_000)
            trace.fact('host-teardown-resolved', null, 'await-continuation')
            persist('before-raw-close-cleanup')
            if (rawClosed) {
              await bounded(rawClosed, 'owned raw close during teardown', 20_000)
            }
            teardownJoined = true
            trace.fact('cleanup-joined', {
              physical: connection?.exitVerdict,
              exitCode: raw?.exitCode,
              signalCode: raw?.signalCode
            })
          } catch (error) {
            failures.push(error)
            trace.fact('cleanup-inconclusive', error)
          } finally {
            persist('final')
            // Direct fd output survives Vitest's passed-only console filtering; full details live in JSON.
            const rows = trace.snapshot()
            writeSync(
              2,
              `startup-ordering receipt=${receipt} phase=final rows=${rows.length} teardownJoined=${teardownJoined} failures=${failures.length}\n`
            )
            for (const row of rows.slice(0, 100)) {
              writeSync(
                2,
                `${lifecycle}/${input} ${JSON.stringify(row, trace.errorJson).slice(0, 1800)}\n`
              )
            }
            trace.identity = () => null
            trace.sourceDone = () => {}
            vi.restoreAllMocks()
            if (directory && teardownJoined) {
              await rm(directory, { recursive: true, force: true })
            }
          }
        }
        if (failures.length) {
          throw new AggregateError(
            failures,
            `${lifecycle}/${input}: inspect ordered receipt ${receipt}`
          )
        }
      },
      70_000
    )
  }
}
