import type * as ProcessTable from '../../shared/libproc-process-table'
import type * as ProcessHost from '@orca/process-host'
import type * as OwnerChannels from './provider-owner-channels'
import type { PassThrough } from 'node:stream'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { DaemonEndpointIdentity } from '../daemon/protocol/daemon-hello-protocol'
import {
  inspectMacProcessCodeIdentity,
  type MacProcessCodeIdentity
} from '../daemon/executable-host/macos/daemon-mac-code-identity'
import { spawnProviderProcess, installProviderProcessHost } from './provider-process-spawn'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { runPsInProcess } from '../../shared/libproc-process-table'
import { HostedProviderChild } from './hosted-provider-child'
import { createProviderSpawnSpec } from './provider-process-supervisor'
import { runLocalSourceControlPlan } from '../text-generation/execution/source-control-local-process'
import { runSourceControlPolicyProbe } from '../text-generation/policies/source-control-policy-probe'
import { runCodexProcessWithHomeLock } from '../text-generation/execution/source-control-local-generation'
import { discoverModelsLocal } from '../text-generation/models/commit-message-model-discovery'
import type { HostedProviderOutcome } from '../daemon/protocol/daemon-provider-process-protocol'
import type { SpawnSourceControlAgent } from '../text-generation/source-control-text-generation-types'
import { runAgentModelCatalogListing } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'

const { owners } = vi.hoisted(
  (): { owners: { duplex: PassThrough; stderr: PassThrough; control: PassThrough }[] } => ({
    owners: []
  })
)

vi.mock('../daemon/executable-host/macos/daemon-mac-code-identity', () => ({
  inspectMacProcessCodeIdentity: vi.fn()
}))

beforeEach(() => {
  vi.mocked(inspectMacProcessCodeIdentity).mockReset().mockResolvedValue({
    identity: 'resolved',
    executablePath: '/fake/Orca Agents'
  })
})

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
        owners.push(this.channels)
        vi.spyOn(this.channels.control, 'write').mockReturnValue(true)
      }
      get outputChannels() {
        return this.channels
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

function pendingChild(
  fallback: () => ChildProcessWithoutNullStreams = () => {
    throw new Error('Duplicate spawn')
  },
  pid = 42
) {
  let disconnected = () => {}
  let reconnected = () => {}
  let exit = (_outcome: HostedProviderOutcome) => {}
  const spec = createProviderSpawnSpec(
    { command: '/fake/codex', args: [], cwd: '/tmp' },
    {},
    'darwin'
  )
  const client = {
    getDaemonIdentity: (): DaemonEndpointIdentity | null => ({
      providerSpawn: true,
      pid: 300,
      startedAtMs: 1,
      launchNonce: 'original-host'
    }),
    ensureConnectedWithin: async () => {},
    request: async (type: string) => (type === 'spawnProvider' ? { pid } : { state: 'unknown' }),
    onProviderExit: (_nonce: string, listener: typeof exit, reconnect?: () => void) => {
      exit = listener
      reconnected = reconnect ?? (() => {})
      return () => {}
    },
    onDisconnected: (listener: () => void) => {
      disconnected = listener
      return () => {}
    }
  }
  const child = new HostedProviderChild(
    spec,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture implements the daemon methods exercised by the hosted child without opening real daemon sockets.
    async () => client as never,
    fallback
  )
  child.on('error', () => {})
  const channels = owners.at(-1)!
  return {
    child,
    client,
    spec,
    channels,
    disconnect: () => disconnected(),
    reconnect: () => reconnected(),
    exit: (code = 1) => {
      channels.duplex.end()
      channels.stderr.end()
      exit({ pid: 42, code, signal: null, processless: false })
    }
  }
}

it.each<{
  label: string
  image: MacProcessCodeIdentity
  replacement?: DaemonEndpointIdentity | null
  hosted: boolean
}>([
  {
    label: 'resolved copy',
    image: { identity: 'resolved', executablePath: '/old-copy/Orca Agents' },
    hosted: true
  },
  {
    label: 'parked copy',
    image: { identity: 'parked', executablePath: '/ShipIt/Orca Agents' },
    hosted: true
  },
  {
    label: 'unlinked image',
    image: { identity: 'unresolvable', executablePath: null },
    hosted: false
  },
  {
    label: 'failed probe',
    image: { identity: 'probe-failed', executablePath: null },
    hosted: false
  },
  {
    label: 'incomplete display',
    image: { identity: 'resolved', executablePath: null },
    hosted: false
  },
  {
    label: 'replaced incarnation',
    image: { identity: 'resolved', executablePath: '/old-copy/Orca Agents' },
    replacement: { providerSpawn: true, pid: 300, startedAtMs: 2, launchNonce: 'replacement-host' },
    hosted: false
  },
  {
    label: 'disconnected host',
    image: { identity: 'resolved', executablePath: '/old-copy/Orca Agents' },
    replacement: null,
    hosted: false
  },
  {
    label: 'lost capability',
    image: { identity: 'resolved', executablePath: '/old-copy/Orca Agents' },
    replacement: { pid: 300, startedAtMs: 1, launchNonce: 'original-host' },
    hosted: false
  }
])('selects exactly one launch for a $label', async ({ image, replacement, hosted }) => {
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  const direct = Object.assign(new EventEmitter(), {
    pid: 400,
    connected: false,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  })
  const fallback = vi.fn(() => {
    queueMicrotask(() => direct.emit('spawn'))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fake direct child implements the streams, events and PID consumed by direct adoption.
    return direct as never
  })
  const handle = pendingChild(fallback)
  const request = vi.spyOn(handle.client, 'request')
  vi.mocked(inspectMacProcessCodeIdentity).mockImplementation(async () => {
    if (replacement !== undefined) {
      vi.spyOn(handle.client, 'getDaemonIdentity').mockReturnValue(replacement)
    }
    return image
  })
  await handle.child.ready
  expect(handle.child.pid).toBe(hosted ? 42 : 400)
  expect(fallback).toHaveBeenCalledTimes(hosted ? 0 : 1)
  expect(request.mock.calls.filter(([type]) => type === 'spawnProvider')).toHaveLength(
    hosted ? 1 : 0
  )
  handle.child.stdout.resume()
  handle.child.stderr.resume()
  if (hosted) {
    handle.exit(0)
  } else {
    direct.stdout.end()
    direct.stderr.end()
    direct.emit('exit', 0, null)
    direct.emit('close', 0, null)
  }
})

it('does not launch either route after Stop during image inspection', async () => {
  const inspection = Promise.withResolvers<MacProcessCodeIdentity>()
  const started = Promise.withResolvers<void>()
  vi.mocked(inspectMacProcessCodeIdentity).mockImplementation(() => {
    started.resolve()
    return inspection.promise
  })
  const fallback = vi.fn(() => {
    throw new Error('Canceled launch')
  })
  const handle = pendingChild(fallback)
  const request = vi.spyOn(handle.client, 'request')
  await started.promise
  handle.child.kill('SIGTERM')
  inspection.resolve({ identity: 'resolved', executablePath: '/old-copy/Orca Agents' })
  await expect(handle.child.ready).rejects.toThrow('Provider launch canceled')
  expect(fallback).not.toHaveBeenCalled()
  expect(request.mock.calls.filter(([type]) => type === 'spawnProvider')).toHaveLength(0)
})

it('keeps a paused final answer until it is read, independently of dead transport cleanup', async () => {
  vi.useFakeTimers()
  const handle = pendingChild()
  const closed = vi.fn()
  handle.child.on('close', closed)
  handle.child.stdout.pause()
  await handle.child.ready
  handle.channels.duplex.write('final-answer')
  handle.exit(0)
  await vi.advanceTimersByTimeAsync(1_100)
  expect(handle.child.rootAbsent).toBe(true)
  expect(handle.channels.duplex.destroyed).toBe(true)
  expect(closed).not.toHaveBeenCalled()
  let output = ''
  handle.child.stdout.on('data', (chunk) => (output += chunk.toString()))
  handle.child.stdout.resume()
  await vi.advanceTimersByTimeAsync(0)
  expect(output).toBe('final-answer')
  expect(closed).toHaveBeenCalledWith(0, null)
})

it('rejects a broken catalog transfer and closes even after an earlier once-error consumer detached', async () => {
  const handle = pendingChild()
  handle.child.removeAllListeners('error')
  handle.child.once('error', () => {})
  handle.child.emit('error', new Error('Earlier unproven connection failure'))
  vi.spyOn(console, 'error').mockImplementation(() => {})
  handle.child.on('error', () => {
    throw new Error('Detached consumer failed')
  })
  const closed = new Promise<void>((resolve) => handle.child.once('close', () => resolve()))
  const listing = runAgentModelCatalogListing(
    { command: 'codex', args: [] },
    {
      site: 'hosted-catalog-transfer',
      platform: 'win32',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The test supplies the same pending provider surface used by production catalog collection.
      spawnImpl: () => handle.child as never
    }
  )
  const rejected = expect(listing).rejects.toMatchObject({ reason: 'exit' })
  await handle.child.ready
  handle.channels.duplex.write('partial-catalog')
  handle.channels.duplex.destroy()
  handle.exit(0)
  await rejected
  await closed
  expect(handle.child.rootAbsent).toBe(true)
  expect(handle.child.exitCode).toBe(0)
})

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
  stdinPayload: null
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

it.skipIf(process.platform === 'win32')(
  'consumes a control-close wake during the final sleep and releases the actual home lock',
  async () => {
    const root = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    const rootClosed = new Promise<void>((resolve) => root.once('close', () => resolve()))
    await once(root, 'spawn')
    try {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const handle = pendingChild(undefined, root.pid!)
      const close = vi.fn()
      handle.child.on('close', close)
      const first = runCodexProcessWithHomeLock('wake-real-root', () =>
        runLocalSourceControlPlan({
          plan,
          cwd: '/tmp',
          env: undefined,
          operation: 'commit-message',
          spawnAgent: () => Object.assign(handle.child, { supervised: true })
        })
      )
      const failed = first.catch(() => ({ success: false }))
      await handle.child.ready
      handle.disconnect()
      await vi.advanceTimersByTimeAsync(7_999)
      expect(handle.child.rootAbsent).toBe(false)
      const secondEntered = vi.fn()
      const second = runCodexProcessWithHomeLock('wake-real-root', () => {
        secondEntered()
        return { result: Promise.resolve('next generation'), processClosed: Promise.resolve() }
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(secondEntered).not.toHaveBeenCalled()
      handle.channels.control.destroy()
      expect(root.kill('SIGTERM')).toBe(true)
      await rootClosed
      await vi.advanceTimersByTimeAsync(1)
      await failed
      expect(await second).toBe('next generation')
      expect(handle.child.rootAbsent).toBe(true)
      expect(close).toHaveBeenCalledExactlyOnceWith(null, null)
    } finally {
      vi.useRealTimers()
      if (root.exitCode === null && root.signalCode === null) {
        root.kill('SIGTERM')
      }
      await rootClosed
    }
  }
)

it('forwards direct stdin failure while preserving actual child exit and close', async () => {
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  const direct = Object.assign(new EventEmitter(), {
    pid: 400,
    connected: false,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  })
  vi.mocked(inspectMacProcessCodeIdentity).mockResolvedValue({
    identity: 'probe-failed',
    executablePath: null
  })
  const handle = pendingChild(() => {
    queueMicrotask(() => direct.emit('spawn'))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Direct fixture supplies the streams and held-child lifecycle under test.
    return direct as never
  })
  const inputFailed = new Promise<Error>((resolve) => handle.child.stdin.once('error', resolve))
  const closed = new Promise<unknown[]>((resolve) =>
    handle.child.once('close', (...args) => resolve(args))
  )
  await handle.child.ready
  const failure = Object.assign(new Error('closed input'), { code: 'EPIPE' })
  direct.stdin.destroy(failure)
  expect(await inputFailed).toBe(failure)
  expect(handle.child.exitCode).toBeNull()
  direct.stdout.end()
  direct.stderr.end()
  direct.emit('exit', 7, null)
  direct.emit('close', 7, null)
  expect(await closed).toEqual([7, null])
})

it('does not renew loss observation from its own reconnect or error cleanup', async () => {
  vi.useFakeTimers()
  vi.spyOn(process, 'kill').mockReturnValue(true)
  const handle = pendingChild()
  const query = vi.spyOn(handle.client, 'request')
  vi.spyOn(handle.client, 'ensureConnectedWithin').mockImplementation(async () =>
    handle.reconnect()
  )
  await handle.child.ready
  handle.child.on('error', () => {
    void Promise.resolve().then(() => handle.child.signalRoot!('SIGTERM'))
  })
  query.mockImplementation(async (type) => {
    if (type === 'signalProvider') {
      throw new Error('Host unavailable')
    }
    return { state: 'unknown' }
  })
  handle.disconnect()
  await vi.advanceTimersByTimeAsync(8_001)
  const stopped = query.mock.calls.length
  await vi.advanceTimersByTimeAsync(16_000)
  expect(query.mock.calls.length).toBe(stopped)
  expect(handle.child.rootAbsent).toBe(false)
  handle.exit()
  await vi.advanceTimersByTimeAsync(0)
})

it('keeps a bounded startup longer than one second hosted instead of spawning twice', async () => {
  vi.useFakeTimers()
  const handle = pendingChild()
  await handle.child.ready
  handle.exit()
  await vi.advanceTimersByTimeAsync(1_001)
  const startup = Promise.withResolvers<typeof handle.client>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Startup resolves to the same daemon-method fixture exercised by the hosted child.
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
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture supplies the streams, PID, events and kill result consumed by direct-child adoption and teardown.
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
