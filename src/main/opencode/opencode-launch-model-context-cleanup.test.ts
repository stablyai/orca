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
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../provider-process/provider-process-supervisor'
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
function close() {
  child.exitCode = 0
  child.emit('exit', 0, null)
  child.emit('close', 0, null)
}
/** How a supervisor ends: its stop signal re-raised once the group is gone, or an exit code. */
function supervisorExits(code: number | null, signal: NodeJS.Signals | null) {
  child.exitCode = code
  child.signalCode = signal
  child.emit('exit', code, signal)
  child.emit('close', code, signal)
}
const options = { executable: '/private/opencode', cwd: directory, env: {} }

function decodedSupervisorSpec(env: unknown): unknown {
  const encoded =
    typeof env === 'object' && env !== null && 'ORCA_PROVIDER_SUPERVISOR_SPEC' in env
      ? String(env.ORCA_PROVIDER_SUPERVISOR_SPEC)
      : ''
  return JSON.parse(Buffer.from(encoded, 'base64').toString() || 'null')
}

async function untilStopRequested(): Promise<void> {
  while (child.kill.mock.calls.length === 0) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

describe('OpenCode model probe termination evidence', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    vi.mocked(readFetchResponseJsonWithinLimit).mockImplementation((response) => response.json())
    child = new ProbeChild()
    closeDuringFetch = false
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
        supervisorExits(null, 'SIGTERM')
      }
      return true
    })
  })

  afterEach(() => {
    vi.useRealTimers()
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
  })

  it('runs a POSIX probe under a one-shot supervisor and stops it through that supervisor', async () => {
    expect(await probeOpenCodeLaunchModelContext(options)).toMatchObject({ primaryAgent: 'build' })

    const [spec] = vi.mocked(spawnProcess).mock.calls[0]
    expect(spec).toMatchObject({ program: process.execPath, cwd: directory, detached: true })
    const args = spec.args ?? []
    expect(args.slice(args.indexOf('--') + 1)).toEqual([
      '/private/opencode',
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      '0'
    ])
    // Its stdin ends at once, so a session lifetime would stop the server a second later.
    expect(decodedSupervisorSpec(spec.env)).toMatchObject({ lifetime: 'one-shot', cwd: directory })
    expect(child.kill.mock.calls).toEqual([['SIGTERM']])
    // Signalling the supervisor's own group, or SIGKILLing it, would orphan the server's group.
    expect(signalProcessTree).not.toHaveBeenCalled()
    expect(forceTerminateProcessTree).not.toHaveBeenCalled()
    expect(terminateProviderProcessTree).not.toHaveBeenCalled()
  })

  it('forces a POSIX supervisor tree only after its full stop time, and trusts no forced stop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    child.kill.mockReturnValue(true)
    // A teardown that found no descendants to check proves nothing about the server's group.
    vi.mocked(terminateProviderProcessTree).mockImplementation(async () => {
      supervisorExits(null, 'SIGKILL')
      return null
    })

    const probe = probeOpenCodeLaunchModelContext(options)
    await untilStopRequested()
    await vi.advanceTimersByTimeAsync(PROVIDER_SUPERVISOR_MAX_STOP_MS - 1)
    expect(terminateProviderProcessTree).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(await probe).toBeNull()
    expect(terminateProviderProcessTree).toHaveBeenCalledWith(child, {
      site: 'opencode-launch-model-preflight'
    })
  })

  it('trusts no forced POSIX stop, even one whose teardown reports the tree gone', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    child.kill.mockReturnValue(true)
    // 'exited' covers the supervisor's tree only; the server leads its own detached group.
    vi.mocked(terminateProviderProcessTree).mockImplementation(async () => {
      supervisorExits(null, 'SIGKILL')
      return 'exited'
    })

    const probe = probeOpenCodeLaunchModelContext(options)
    await untilStopRequested()
    await vi.advanceTimersByTimeAsync(PROVIDER_SUPERVISOR_MAX_STOP_MS)

    expect(await probe).toBeNull()
  })

  it('trusts no POSIX stop whose supervisor exited 1, which a failed group reap also exits', async () => {
    child.kill.mockImplementation(() => {
      supervisorExits(1, null)
      return true
    })

    expect(await probeOpenCodeLaunchModelContext(options)).toBeNull()
    expect(terminateProviderProcessTree).not.toHaveBeenCalled()
  })

  it('accepts a POSIX supervisor that relayed the server exiting on its own', async () => {
    child.kill.mockImplementation(() => {
      supervisorExits(0, null)
      return true
    })

    expect(await probeOpenCodeLaunchModelContext(options)).toMatchObject({ primaryAgent: 'build' })
  })

  it('never forces a POSIX supervisor whose root exited without closing its pipes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    child.kill.mockImplementation(() => {
      child.exitCode = 0
      child.emit('exit', 0, null)
      return true
    })

    const probe = probeOpenCodeLaunchModelContext(options)
    await untilStopRequested()
    await vi.advanceTimersByTimeAsync(PROVIDER_SUPERVISOR_MAX_STOP_MS)

    expect(await probe).toBeNull()
    expect(terminateProviderProcessTree).not.toHaveBeenCalled()
  })

  it('keeps a Windows root exit with inherited pipes unverified and avoids its former pid', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.mocked(signalProcessTree).mockImplementation(async () => {
      child.exitCode = 0
      child.emit('exit', 0, null)
      return false
    })
    expect(await probeOpenCodeLaunchModelContext(options)).toBeNull()
    expect(forceTerminateProcessTree).not.toHaveBeenCalled()
  })

  it('requires verified termination when a still-live Windows probe does not close', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.mocked(signalProcessTree).mockResolvedValue(true)
    expect(await probeOpenCodeLaunchModelContext(options)).toBeNull()
    expect(forceTerminateProcessTree).toHaveBeenCalledOnce()
  })
})
