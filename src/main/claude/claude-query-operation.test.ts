import { Duplex, PassThrough } from 'node:stream'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createClaudeQueryOperation } from './claude-query-operation'
import { ClaudeControlRequestError } from './claude-agent-sdk-control-requests'
import { findInErrorChain } from '../provider-process/provider-error-chain'
import { spawnManagedProviderProcess } from '../provider-process/managed-provider-process'
import { createProviderSourceCompletion } from '../provider-process/provider-source-completion'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import {
  providerExecutableMissing,
  providerLaunchFolderMissing
} from '../provider-process/provider-executable-missing'

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
  const managed = spawnManagedProviderProcess(
    { command: 'agent', args: [] },
    { site: 'query-operation-test', platform: 'win32', spawnImpl: () => child }
  )
  const finishDiagnostics = vi.fn(diagnostics.finish)
  const operation = createClaudeQueryOperation()
  operation.start(
    {
      initializationResult: () => Promise.reject(new Error('Query closed before response received'))
    },
    {
      ...managed,
      finishDiagnostics,
      stderrTail: () => tail,
      exitStatus: null
    }
  )
  await vi.waitFor(() => expect(finishDiagnostics).toHaveBeenCalledOnce())
  stderr.end('--dangerously-skip-permissions cannot be used with root\n')
  await expect(operation.result).rejects.toThrow('cannot be used with root')
  expect(operation.failure?.failure.kind).toBe('fullAccessAsRoot')
  expect(child.exitCode).toBeNull()
})

function launch(supervised: boolean, command = '/orca-query-missing-agent', cwd = process.cwd()) {
  const injected = supervised ? createFakePipedChild(424242) : undefined
  const incoming = new PassThrough(),
    outgoing = new PassThrough()
  let ack = ''
  outgoing.on('data', (bytes) => {
    ack += String(bytes)
  })
  const channel = supervised ? Duplex.from({ readable: incoming, writable: outgoing }) : null
  if (injected) {
    injected.stdio[3] = channel
  }
  const managed = spawnManagedProviderProcess(
    { command, args: [], cwd },
    {
      site: 'query-operation-cut-test',
      platform: supervised ? 'darwin' : 'win32',
      ...(injected ? { spawnImpl: () => injected } : {})
    }
  )
  const child = managed.child
  const initialize = Promise.withResolvers<unknown>()
  const operation = createClaudeQueryOperation()
  operation.start({ initializationResult: () => initialize.promise }, managed)
  const finish = async () => {
    if (!supervised) {
      await managed.exitPromise
      await managed.close()
    }
    managed.launchReport.retire()
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
    channel?.destroy()
    incoming.destroy()
    outgoing.destroy()
    await managed.launchReport.closed
  }
  return { child, incoming, managed, initialize, operation, finish, ack: () => ack }
}

it.each(['spawned', 'failed'] as const)(
  'keeps abandoned semantic evidence immutable while late raw %s still commits and ACKs',
  async (kind) => {
    const source = launch(true)
    try {
      source.managed.abandonLaunchObservation()
      expect(await source.managed.launchReport.done).toBeNull()
      source.incoming.write(
        `${JSON.stringify(
          kind === 'spawned'
            ? { kind, pgid: 4321 }
            : {
                kind,
                thrown: false,
                error: {
                  message: 'original ENOENT',
                  code: 'ENOENT',
                  path: '/orca-query-missing-agent'
                }
              }
        )}\n`
      )
      await new Promise<void>((resolve) => source.managed.launchReport.subscribe(() => resolve()))
      expect(source.managed.launchReport.record?.kind).toBe(kind)
      expect(source.ack()).toBe('{"kind":"committed"}\n')
      source.child.stderr.end()
      source.initialize.reject(new Error('Query closed before response received'))
      const error = await source.operation.result.catch((cause: unknown) => cause)
      expect(providerExecutableMissing(error)).toBe(false)
      expect(source.operation.failure?.failure.kind).not.toBe('cliMissing')
    } finally {
      await source.finish()
    }
  }
)

it('uses only a genuine in-cut failed report to refine generic SDK closure', async () => {
  const source = launch(true)
  try {
    source.incoming.write(
      `${JSON.stringify({
        kind: 'failed',
        thrown: false,
        error: { message: 'spawn agent ENOENT', code: 'ENOENT', path: '/orca-query-missing-agent' }
      })}\n`
    )
    await source.managed.launchReport.done
    source.child.stderr.end()
    source.initialize.reject(new Error('Query closed before response received'))
    const error = await source.operation.result.catch((cause: unknown) => cause)
    expect(providerExecutableMissing(error)).toBe(true)
    expect(source.operation.failure?.failure.kind).toBe('cliMissing')
  } finally {
    await source.finish()
  }
})

it('preserves a meaningful original control refusal from the launched provider', async () => {
  const source = launch(true)
  const original = new ClaudeControlRequestError('initialize', 'original refusal')
  try {
    source.incoming.write('{"kind":"spawned","pgid":4321}\n')
    await source.managed.launchReport.done
    source.initialize.reject(original)
    await expect(source.operation.result).rejects.toBe(original)
  } finally {
    await source.finish()
  }
})

it.each(['executable', 'launchFolder', 'interpreter', 'abandoned'] as const)(
  'classifies real direct %s evidence at rejection, never at construction or after abandonment',
  async (kind) => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-query-cut-'))
    const command =
      kind === 'interpreter'
        ? join(dir, 'existing')
        : kind === 'launchFolder'
          ? process.execPath
          : '/orca-query-missing-agent'
    if (kind === 'interpreter') {
      writeFileSync(command, '#!/orca-missing-interpreter\n')
      chmodSync(command, 0o755)
    }
    const source = launch(false, command, kind === 'launchFolder' ? join(dir, 'gone') : dir)
    const spawnError = new Promise<Error>((resolve) => source.child.once('error', resolve))
    try {
      if (kind === 'abandoned') {
        source.managed.abandonLaunchObservation()
      }
      expect(await source.managed.launchReport.done).toBeNull()
      const original = await spawnError
      source.initialize.reject(new Error('Query closed before response received'))
      const error = await source.operation.result.catch((cause: unknown) => cause)
      expect(providerExecutableMissing(error)).toBe(kind === 'executable')
      expect(providerLaunchFolderMissing(error)).toBe(kind === 'launchFolder')
      expect(findInErrorChain(error, (inner) => (inner === original ? true : undefined))).toBe(
        kind === 'abandoned' ? undefined : true
      )
      await source.managed.exitPromise
      expect(source.managed.processless).toBe(true)
      expect(source.managed.rootExitObserved).toBe(false)
    } finally {
      await source.finish()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
