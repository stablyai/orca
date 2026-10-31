import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { createClaudeQueryOperation } from './claude-query-operation'
import { ClaudeControlRequestError } from './claude-agent-sdk-control-requests'
import { createProviderLaunchReport } from '../provider-process/provider-launch-report'
import { createProviderSourceCompletion } from '../provider-process/provider-source-completion'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { providerExecutableMissing } from '../provider-process/provider-executable-missing'

it('keeps the captured initialize refusal when cleanup races its continuation', async () => {
  const initialize = Promise.withResolvers<unknown>()
  const operation = createClaudeQueryOperation()
  const original = new ClaudeControlRequestError('initialize', 'original refusal')
  operation.start({ initializationResult: () => initialize.promise })
  initialize.reject(original)
  // Physical completion cannot select a different semantic error.
  await expect(operation.result).rejects.toBe(original)
  expect(operation.failure?.error).toBe(original)
  expect(operation.failure?.initiator).toBe('startup-failure')
})

it('owns a synchronous Query construction failure before a connection can be returned', async () => {
  const operation = createClaudeQueryOperation()
  const original = new Error('Query construction refused')
  expect(() =>
    operation.capture(() => {
      throw original
    })
  ).toThrow(original)
  await expect(operation.result).rejects.toBe(original)
})

it('completes resident stderr independently of an unobserved root before projecting refusal', async () => {
  const child = createFakePipedChild(424242)
  const stderr = new PassThrough()
  let tail = ''
  const diagnostics = createProviderSourceCompletion(stderr, {
    data: (chunk) => {
      tail += chunk
    },
    end: () => {},
    error: () => {}
  })
  const report = createProviderLaunchReport(child, false)
  const finishDiagnostics = vi.fn(diagnostics.finish)
  const operation = createClaudeQueryOperation()
  operation.start(
    {
      initializationResult: () => Promise.reject(new Error('Query closed before response received'))
    },
    {
      launchReport: report,
      finishDiagnostics,
      stderrTail: () => tail,
      exitStatus: null,
      spawnAbsence: null
    }
  )
  await vi.waitFor(() => expect(finishDiagnostics).toHaveBeenCalledOnce())
  stderr.end('--dangerously-skip-permissions cannot be used with root\n')
  await expect(operation.result).rejects.toThrow('cannot be used with root')
  expect(operation.failure?.failure.kind).toBe('fullAccessAsRoot')
  expect(child.exitCode).toBeNull()
})

it('uses a genuine pre-spawn report even when default SDK cleanup wraps closure as a control error', async () => {
  const child = createFakePipedChild(424242)
  const report = createProviderLaunchReport(child, false)
  const original = new ClaudeControlRequestError('initialize', 'SDK cleanup')
  const operation = createClaudeQueryOperation()
  operation.start(
    { initializationResult: () => Promise.reject(original) },
    {
      launchReport: {
        ...report,
        record: {
          kind: 'failed',
          thrown: false,
          error: Object.assign(new Error('spawn agent ENOENT'), { code: 'ENOENT' })
        },
        done: Promise.resolve({
          kind: 'failed',
          thrown: false,
          error: Object.assign(new Error('spawn agent ENOENT'), { code: 'ENOENT' })
        })
      },
      finishDiagnostics: async () => {},
      stderrTail: () => '',
      exitStatus: null,
      spawnAbsence: 'executable'
    }
  )
  const error = await operation.result.catch((cause: unknown) => cause)
  expect(providerExecutableMissing(error)).toBe(true)
  expect(operation.failure?.failure.kind).toBe('cliMissing')
})
