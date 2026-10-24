import * as ledger from '../provider-process/provider-process-ledger'
import * as rows from '../provider-process/provider-process-row-read'
import { setTimeout as realDelay } from 'node:timers/promises'
import { z } from 'zod'
import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import {
  forceTerminateProcessTree,
  signalProcessTree
} from '@orca/process-host/process-tree-termination'
import { probeOpenCodeLaunchModelContext } from './opencode-launch-model-context'
import { readFetchResponseJsonWithinLimit } from '../../shared/fetch-response-body'
import { terminateProviderProcessTree } from '../provider-process/provider-process-teardown'

vi.mock('@orca/process-host', () => ({ spawnProcess: vi.fn() }))
vi.mock('@orca/process-host/process-tree-termination', () => ({
  signalProcessTree: vi.fn(),
  forceTerminateProcessTree: vi.fn()
}))
vi.mock('../provider-process/provider-process-teardown', () => ({
  terminateProviderProcessTree: vi.fn()
}))

vi.mock('../../shared/fetch-response-body', () => ({ readFetchResponseJsonWithinLimit: vi.fn() }))

class ProbeChild extends ChildProcess {
  override stdin = new PassThrough()
  override stdout = new PassThrough()
  override stderr = new PassThrough()
  override pid = 123456
  override exitCode: number | null = null
  override signalCode: NodeJS.Signals | null = null
  // A handle-less ChildProcess's own kill can signal this test's process group.
  override kill = vi.fn((_signal?: NodeJS.Signals | number): boolean => true)
  override stdio: [PassThrough, PassThrough, PassThrough, undefined, undefined] = [
    this.stdin,
    this.stdout,
    this.stderr,
    undefined,
    undefined
  ]
}

const directory = '/private/project'
const model = { id: 'model-b', providerID: 'private-proof', enabled: true }
const snapshot = {
  model: { location: { directory }, data: [model] },
  agent: {
    location: { directory },
    data: [{ id: 'build', mode: 'primary', hidden: false, model }]
  },
  'model/default': { location: { directory }, data: model },
  config: [{ type: 'document', info: { default_agent: 'build' } }]
}
const platform = Object.getOwnPropertyDescriptor(process, 'platform')
let child: ProbeChild
let closeDuringFetch = false
let groupAlive = true
function close() {
  child.exitCode = 0
  child.emit('exit', 0, null)
  child.emit('close', 0, null)
}
function childExits(code: number | null, signal: NodeJS.Signals | null) {
  groupAlive = false
  child.exitCode = code
  child.signalCode = signal
  child.emit('exit', code, signal)
  child.emit('close', code, signal)
}
const options = { executable: '/private/opencode', cwd: directory, env: {} }

async function untilStopRequested(
  requested = () => child.kill.mock.calls.length > 0
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (requested()) {
      return
    }
    await realDelay(10)
  }
  throw new Error('probe did not request stop')
}

describe('OpenCode model probe termination evidence', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    vi.mocked(readFetchResponseJsonWithinLimit).mockImplementation((response) => response.json())
    child = new ProbeChild()
    vi.spyOn(ledger, 'recordProviderLaunch').mockReturnValue({
      capture: async () => {},
      retire: async () => {},
      members: () => [{ pid: child.pid, pgid: child.pid, startedAt: 'fixture' }]
    })
    vi.spyOn(rows, 'readPosixProcessRow').mockImplementation(async () => ({
      pid: child.pid,
      pgid: child.pid,
      ppid: process.pid,
      startedAt: 'fixture',
      startResolution: 'clock-tick'
    }))
    closeDuringFetch = false
    groupAlive = true
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid !== -child.pid) {
        throw new Error('unexpected test signal')
      }
      if (!groupAlive) {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      }
      if (signal === 'SIGTERM') {
        child.kill('SIGTERM')
      }
      return true
    })
    vi.mocked(spawnProcess).mockImplementation(() => {
      queueMicrotask(() => child.stdout.write('server listening on http://127.0.0.1:45678\n'))
      return child
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL) => {
        const endpoint = z
          .enum(['model', 'agent', 'model/default', 'config'])
          .parse(input.pathname.slice('/api/'.length))
        const response = snapshot[endpoint]
        if (closeDuringFetch && endpoint === 'config') {
          queueMicrotask(close)
        }
        return new Response(JSON.stringify(response), { status: 200 })
      })
    )
    vi.mocked(signalProcessTree).mockImplementation(async () => {
      close()
      return true
    })
    vi.mocked(forceTerminateProcessTree).mockResolvedValue(false)
    child.kill.mockImplementation((signal) => {
      if (signal === 'SIGTERM') {
        childExits(null, 'SIGTERM')
      }
      return true
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
    vi.unstubAllGlobals()
  })

  it('cancels all unread responses if the bounded body reader fails', async () => {
    const cancel = vi.fn()
    vi.mocked(readFetchResponseJsonWithinLimit).mockRejectedValue(new Error('body_reader_failed'))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 200 }))
    )
    expect(await probeOpenCodeLaunchModelContext(options)).toBeNull()
    expect(cancel).toHaveBeenCalledTimes(4)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('accepts an already-closed Windows probe without signaling its former pid', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    closeDuringFetch = true
    vi.mocked(signalProcessTree).mockResolvedValue(false)
    expect(await probeOpenCodeLaunchModelContext(options)).toMatchObject({ primaryAgent: 'build' })
    expect(signalProcessTree).not.toHaveBeenCalled()
    expect(forceTerminateProcessTree).not.toHaveBeenCalled()
    expect(vi.mocked(spawnProcess).mock.calls[0][0]).toMatchObject({ detached: true })
  })

  it('starts the configured POSIX server directly and accepts only observed group exit', async () => {
    expect(await probeOpenCodeLaunchModelContext(options)).toMatchObject({ primaryAgent: 'build' })
    expect(vi.mocked(spawnProcess).mock.calls[0][0]).toMatchObject({
      program: '/private/opencode',
      cwd: directory,
      detached: true,
      args: ['serve', '--hostname', '127.0.0.1', '--port', '0'],
      stdio: ['pipe', 'pipe', 'pipe']
    })
    expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM')
    expect(signalProcessTree).not.toHaveBeenCalled()
    expect(forceTerminateProcessTree).not.toHaveBeenCalled()
  })

  it('discards results when root exit leaves the POSIX group alive', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    child.kill.mockImplementation(() => {
      child.exitCode = 0
      child.emit('exit', 0, null)
      child.emit('close', 0, null)
      return true
    })
    const probe = probeOpenCodeLaunchModelContext(options)
    await untilStopRequested()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await probe).toBeNull()
    expect(terminateProviderProcessTree).not.toHaveBeenCalled()
  })

  it('keeps a Windows root exit with inherited pipes unverified and avoids its former pid', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.mocked(signalProcessTree).mockImplementation(async () => {
      child.exitCode = 0
      child.emit('exit', 0, null)
      return false
    })
    let settled = false
    const probe = probeOpenCodeLaunchModelContext(options).finally(() => (settled = true))
    await untilStopRequested(() => vi.mocked(signalProcessTree).mock.calls.length > 0)
    await vi.advanceTimersByTimeAsync(1_499)
    expect(settled).toBe(false)
    expect(forceTerminateProcessTree).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(await probe).toBeNull()
    expect(forceTerminateProcessTree).not.toHaveBeenCalled()
  })

  it('requires verified termination when a still-live Windows probe does not close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.mocked(signalProcessTree).mockResolvedValue(true)
    let settled = false
    const probe = probeOpenCodeLaunchModelContext(options).finally(() => (settled = true))
    await untilStopRequested(() => vi.mocked(signalProcessTree).mock.calls.length > 0)
    await vi.advanceTimersByTimeAsync(1_499)
    expect(settled).toBe(false)
    expect(forceTerminateProcessTree).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(await probe).toBeNull()
    expect(forceTerminateProcessTree).toHaveBeenCalledOnce()
  })
})
