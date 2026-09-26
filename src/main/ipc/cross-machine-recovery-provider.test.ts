import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, runProcess, spawnProcess, signalProcessTree } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  runProcess: vi.fn(),
  spawnProcess: vi.fn(),
  signalProcessTree: vi.fn(async () => true)
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler)
  }
}))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess, spawnProcess }))
vi.mock('../../shared/child-process/process-tree-termination', () => ({ signalProcessTree }))

import {
  createCrossMachineRecoveryProvider,
  PICKUP_PROGRESS_CHANNEL,
  registerCrossMachineRecoveryProviderHandlers
} from './cross-machine-recovery-provider'
import { getDefaultSettings } from '../../shared/constants'
import type { ProcessResult } from '../../shared/child-process/process-spec'

const LIST = {
  version: 1,
  ok: true,
  generated_at: '2026-09-26T00:00:00Z',
  local: { host_id: 'h', host_name: 'studio' },
  items: []
}
const PICKUP = {
  version: 1,
  ok: true,
  checkout: { path: '/w', branch: 'main', reused: false },
  sessions: [{ session_id: 's1', status: 'resumed' }],
  orca: {
    execution_host_id: 'local',
    worktree_id: 'wt1',
    resumed: [{ session_id: 's1', tab_id: 't1' }],
    dormant: []
  }
}

function processResult(overrides: Partial<ProcessResult>): ProcessResult {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides }
}

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
    stdout: new EventEmitter(),
    stderr: new EventEmitter()
  })
  spawnProcess.mockReturnValue(child)
  return child
}

const sender = { send: vi.fn(), isDestroyed: () => false }

beforeEach(() => {
  handlers.clear()
  runProcess.mockReset()
  spawnProcess.mockReset()
  signalProcessTree.mockClear()
  sender.send.mockReset()
})

describe('cross-machine recovery provider bridge', () => {
  it('runs the configured provider with a scrubbed env, --json, a timeout and an output cap', async () => {
    vi.stubEnv('ORCA_ENVIRONMENT', 'remote')
    vi.stubEnv('ORCA_PAIRING_CODE', 'code')
    vi.stubEnv('ORCA_REMOTE_PAIRING', '1')
    runProcess.mockResolvedValue(processResult({ stdout: JSON.stringify(LIST) }))
    registerCrossMachineRecoveryProviderHandlers({
      getSettings: () => ({
        ...getDefaultSettings('/tmp'),
        crossMachineRecovery: { providerPath: '/opt/cc-sync' }
      })
    })
    const result = await handlers.get('crossMachineRecovery:list')?.(
      {},
      { clientInstanceId: 'client-1', source: 'laptop' }
    )
    expect(result).toEqual({ ok: true, value: LIST })
    const spec = runProcess.mock.calls[0][0]
    expect(spec.program).toBe('/opt/cc-sync')
    expect(spec.args).toEqual(['list', '--source', 'laptop', '--json'])
    expect(spec.timeoutMs).toBe(15_000)
    expect(spec.maxOutputBytes).toBe(4 * 1024 * 1024)
    expect(spec.env.CC_SYNC_ORCA_CLIENT_INSTANCE_ID).toBe('client-1')
    for (const key of ['ORCA_ENVIRONMENT', 'ORCA_PAIRING_CODE', 'ORCA_REMOTE_PAIRING']) {
      expect(spec.env).not.toHaveProperty(key)
    }
    vi.unstubAllEnvs()
  })

  it.each([
    [
      'ENOENT',
      () =>
        runProcess.mockRejectedValue(
          Object.assign(new Error('spawn cc-sync ENOENT'), { code: 'ENOENT' })
        ),
      'not-installed'
    ],
    [
      'typed failure',
      () =>
        runProcess.mockResolvedValue(
          processResult({
            code: 4,
            stdout: JSON.stringify({
              version: 1,
              ok: false,
              error: { code: 'not-ready', message: 'no checkpoint' }
            })
          })
        ),
      'not-ready'
    ],
    [
      'output cap',
      () =>
        runProcess.mockResolvedValue(
          processResult({ stdout: '{"version":1', outputTruncated: true })
        ),
      'output-too-large'
    ],
    [
      'timeout',
      () => runProcess.mockResolvedValue(processResult({ code: null, timedOut: true })),
      'timeout'
    ],
    [
      'non-JSON failure',
      () => runProcess.mockResolvedValue(processResult({ code: 2, stderr: 'usage: cc-sync' })),
      'provider-failed'
    ]
  ])('maps %s to a typed error', async (_name, arrange, code) => {
    arrange()
    const provider = createCrossMachineRecoveryProvider(() => 'cc-sync')
    const result = await provider.status('client-1')
    expect(result).toMatchObject({ ok: false, error: { code } })
  })

  it('streams pickup progress by operation id and parses the final answer', async () => {
    const child = fakeChild()
    const provider = createCrossMachineRecoveryProvider(() => 'cc-sync')
    const pending = provider.pickup(sender, {
      clientInstanceId: 'client-1',
      operationId: 'op-1',
      selector: 'laptop/ws',
      resume: ['s1', 's2']
    })
    const spec = spawnProcess.mock.calls[0][0]
    expect(spec.args).toEqual([
      'pickup',
      'laptop/ws',
      '--resume',
      's1',
      '--resume',
      's2',
      '--progress',
      'ndjson',
      '--json'
    ])
    expect(spec.detached).toBe(true)
    expect(spec.env.CC_SYNC_ORCA_CLIENT_INSTANCE_ID).toBe('client-1')
    child.stderr.emit('data', Buffer.from('warning: slow disk\n{"phase":"restore-'))
    child.stderr.emit('data', Buffer.from('code","done":1,"total":2}\n'))
    child.stdout.emit('data', Buffer.from(JSON.stringify(PICKUP)))
    child.emit('close', 0)
    await expect(pending).resolves.toEqual({ ok: true, value: PICKUP })
    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(sender.send).toHaveBeenCalledWith(PICKUP_PROGRESS_CHANNEL, {
      operationId: 'op-1',
      progress: { phase: 'restore-code', done: 1, total: 2 }
    })
  })

  it('cancels a pickup by signalling its process group', async () => {
    const child = fakeChild()
    const provider = createCrossMachineRecoveryProvider(() => 'cc-sync')
    const pending = provider.pickup(sender, {
      clientInstanceId: 'c',
      operationId: 'op-2',
      selector: 'a/b',
      resume: []
    })
    await provider.cancel('op-2')
    expect(signalProcessTree).toHaveBeenCalledWith(child, 'SIGTERM')
    child.emit('close', null)
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })

  it('reports a missing provider binary during pickup as not installed', async () => {
    const child = fakeChild()
    const provider = createCrossMachineRecoveryProvider(() => 'cc-sync')
    const pending = provider.pickup(sender, {
      clientInstanceId: 'c',
      operationId: 'op-3',
      selector: 'a/b',
      resume: []
    })
    child.emit('error', Object.assign(new Error('spawn cc-sync ENOENT'), { code: 'ENOENT' }))
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'not-installed' } })
  })
})
