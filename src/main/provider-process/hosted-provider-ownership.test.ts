import type * as ProcessTable from '../../shared/libproc-process-table'
import type * as ProcessHost from '@orca/process-host'
import type * as OwnerChannels from './provider-owner-channels'
import { spawnProviderProcess, installProviderProcessHost } from './provider-process-spawn'
import { afterEach, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { runPsInProcess } from '../../shared/libproc-process-table'
import { HostedProviderChild } from './hosted-provider-child'
import { createProviderSpawnSpec } from './provider-process-supervisor'
import { runLocalSourceControlPlan } from '../text-generation/source-control-local-process'
import { runSourceControlPolicyProbe } from '../text-generation/source-control-policy-probe'
import { runCodexProcessWithHomeLock } from '../text-generation/source-control-local-generation'
import { discoverModelsLocal } from '../text-generation/commit-message-model-discovery'
import type { HostedProviderOutcome } from '../daemon/protocol/daemon-provider-process-protocol'
import type { SpawnSourceControlAgent } from '../text-generation/source-control-text-generation-types'

vi.mock('@orca/process-host', async (original) => ({
  ...(await original<typeof ProcessHost>()),
  runProcess: vi.fn()
}))
vi.mock('../../shared/libproc-process-table', async (original) => ({
  ...(await original<typeof ProcessTable>()),
  runPsInProcess: vi.fn()
}))
vi.mock('./provider-owner-channels', async (original) => {
  const actual = await original<typeof OwnerChannels>()
  const { PassThrough } = await import('node:stream')
  return {
    ...actual,
    ProviderOwnerListener: class {
      nonce = 'a'.repeat(64)
      channels = {
        duplex: new PassThrough(),
        stderr: new PassThrough(),
        control: new PassThrough()
      }
      ready = Promise.resolve(this.channels)
      constructor() {
        vi.spyOn(this.channels.control, 'write').mockReturnValue(true)
      }
      async listen() {
        return '/fake/owner.sock'
      }
      bindPid() {}
      async close() {
        for (const socket of Object.values(this.channels)) {
          socket.destroy()
        }
      }
    }
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function pendingChild() {
  let disconnected = () => {}
  let exit = (_outcome: HostedProviderOutcome) => {}
  const spec = createProviderSpawnSpec(
    { command: '/fake/codex', args: [], cwd: '/tmp' },
    {},
    'darwin'
  )
  const client = {
    getDaemonIdentity: () => ({ providerSpawn: true, pid: 300 }),
    ensureConnectedWithin: async () => {},
    request: async (type: string) =>
      type === 'spawnProvider' ? { pid: 42 } : { state: 'unknown' },
    onProviderExit: (_nonce: string, listener: typeof exit) => {
      exit = listener
      return () => {}
    },
    onDisconnected: (listener: () => void) => {
      disconnected = listener
      return () => {}
    }
  }
  const child = new HostedProviderChild(
    spec,
    async () => client as never,
    () => {
      throw new Error('Duplicate spawn')
    }
  )
  child.on('error', () => {})
  return {
    child,
    client,
    spec,
    disconnect: () => disconnected(),
    exit: () => exit({ pid: 42, code: 1, signal: null, processless: false })
  }
}

it.each([10, 100])(
  'observes %i lost roots without process-table reads or fabricated close',
  async (count) => {
    vi.useFakeTimers()
    vi.spyOn(process, 'kill').mockReturnValue(true)
    const handles = Array.from({ length: count }, pendingChild)
    const closes = handles.map(({ child }) => {
      const close = vi.fn()
      child.on('close', close)
      return close
    })
    await Promise.all(handles.map(({ child }) => child.ready))
    for (const handle of handles) {
      handle.disconnect()
    }
    await vi.advanceTimersByTimeAsync(8_001)
    expect(closes.every((close) => close.mock.calls.length === 0)).toBe(true)
    expect(handles.every(({ child }) => !child.rootAbsent)).toBe(true)
    expect(runPsInProcess).not.toHaveBeenCalled()
    expect(runProcess).not.toHaveBeenCalled()
    for (const handle of handles) {
      handle.exit()
    }
    await vi.advanceTimersByTimeAsync(1_001)
    expect(closes.every((close) => close.mock.calls.length === 1)).toBe(true)
  }
)

const plan = {
  binary: 'codex',
  args: [],
  label: 'Codex',
  stdinPayload: null,
  outputFormat: 'text' as const
}

it.each(['generation', 'policy', 'models'] as const)(
  'holds the Codex home after unproven %s failure until real exit',
  async (flow) => {
    vi.useFakeTimers()
    vi.spyOn(process, 'kill').mockReturnValue(true)
    const handle = pendingChild()
    const spawnAgent: SpawnSourceControlAgent = () =>
      Object.assign(handle.child, { supervised: true })
    const lock = `hosted-ownership-${flow}`
    const start = () =>
      flow === 'generation'
        ? runLocalSourceControlPlan({
            plan,
            cwd: '/tmp',
            env: undefined,
            operation: 'commit-message',
            spawnAgent
          })
        : runSourceControlPolicyProbe({
            plan,
            args: [],
            target: { kind: 'local', cwd: '/tmp' },
            signal: new AbortController().signal,
            spawnAgent
          })
    const first =
      flow === 'models'
        ? discoverModelsLocal({
            agentId: 'codex',
            env: { CODEX_HOME: lock },
            options: {},
            backslash: 'escape',
            spawnAgent
          })
        : runCodexProcessWithHomeLock<unknown>(lock, start)
    // Consume failures before injecting transport loss; a result is not physical exit proof.
    const failed = Promise.resolve(first).catch(() => ({ success: false }))
    await handle.child.ready
    handle.disconnect()
    await vi.advanceTimersByTimeAsync(8_001)
    await failed
    const secondStarted = vi.fn()
    const second =
      flow === 'models'
        ? discoverModelsLocal({
            agentId: 'codex',
            env: { CODEX_HOME: lock },
            options: {},
            backslash: 'escape',
            spawnAgent: () => {
              secondStarted()
              throw new Error('No second process needed')
            }
          })
        : runCodexProcessWithHomeLock(lock, () => {
            secondStarted()
            return { result: Promise.resolve('second'), processClosed: Promise.resolve() }
          })
    await vi.advanceTimersByTimeAsync(0)
    expect(secondStarted).not.toHaveBeenCalled()
    handle.exit()
    await vi.advanceTimersByTimeAsync(7_501)
    await second
    expect(secondStarted).toHaveBeenCalledTimes(1)
  }
)

it('keeps a bounded startup longer than one second hosted instead of spawning twice', async () => {
  vi.useFakeTimers()
  const handle = pendingChild()
  await handle.child.ready
  handle.exit()
  await vi.advanceTimersByTimeAsync(1_001)
  const startup = Promise.withResolvers<typeof handle.client>()
  installProviderProcessHost(async () => startup.promise as never)
  const direct = vi.fn(() => {
    throw new Error('Unexpected fallback')
  })
  const child = spawnProviderProcess(handle.spec, direct)
  child.on('error', () => {})
  await vi.advanceTimersByTimeAsync(1_201)
  expect(direct).not.toHaveBeenCalled()
  startup.resolve(handle.client)
  await child.ready
  expect(child.pid).toBe(42)
  expect(direct).not.toHaveBeenCalled()
  handle.exit()
  await vi.advanceTimersByTimeAsync(1_001)
  installProviderProcessHost(async () => null)
})

it('keeps direct-fallback tree cleanup when its first stop signal fails', async () => {
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  const { terminateProviderProcessTree } = await import('./provider-process-teardown')
  const direct = Object.assign(new EventEmitter(), {
    pid: 400,
    connected: false,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => false)
  })
  const spec = createProviderSpawnSpec(
    { command: '/fake/codex', args: [], cwd: '/tmp' },
    {},
    'darwin'
  )
  const child = new HostedProviderChild(
    spec,
    async () => null,
    () => {
      queueMicrotask(() => direct.emit('spawn'))
      return direct as never
    }
  )
  child.on('error', () => {})
  await child.ready
  expect(child.signalRoot).toBeUndefined()
  expect(child.kill('SIGINT')).toBe(false)
  direct.kill.mockClear()
  await terminateProviderProcessTree(child, {
    site: 'direct-fallback-test',
    supervised: true,
    captureDescendants: async () => null
  })
  expect(direct.kill.mock.calls).toEqual([['SIGSTOP'], ['SIGKILL']])
  direct.emit('close', null, null)
})
