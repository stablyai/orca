import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shouldDeferStartupCommand } from './startup-command-load-gate'
import { TerminalHost } from './terminal-host'
import type { SubprocessHandle } from './session-subprocess-handle'

// Hoisted: vi.mock factories are lifted to module scope regardless of where
// they appear, so it must be declared here to apply to the import graph.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const mocked = {
    ...actual,
    loadavg: (): number[] => [99, 0, 0],
    cpus: () => new Array(8)
  }
  return { ...mocked, default: mocked }
})

function mockSubprocess(): SubprocessHandle {
  return {
    pid: 1,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData: () => {},
    onExit: () => {},
    dispose: vi.fn()
  } as SubprocessHandle
}

const fixedInputs = (load1: number, cpuCount = 8, platform: NodeJS.Platform = 'darwin') => ({
  loadavg: () => [load1, 0, 0] as number[],
  cpuCount,
  platform
})

describe('shouldDeferStartupCommand', () => {
  it('never defers when the env var is unset or empty (default off)', () => {
    expect(shouldDeferStartupCommand({}, fixedInputs(99))).toEqual({ deferred: false })
    expect(shouldDeferStartupCommand({ ORCA_STARTUP_COMMAND_MAX_LOAD_PER_CPU: '' }, fixedInputs(99)))
      .toEqual({ deferred: false })
  })

  it('never defers on unparseable or non-positive values', () => {
    for (const bad of ['abc', '0', '-2']) {
      expect(
        shouldDeferStartupCommand({ ORCA_STARTUP_COMMAND_MAX_LOAD_PER_CPU: bad }, fixedInputs(99))
      ).toEqual({ deferred: false })
    }
  })

  it('does not defer when 1-min load is within limit × cpus', () => {
    expect(
      shouldDeferStartupCommand(
        { ORCA_STARTUP_COMMAND_MAX_LOAD_PER_CPU: '2' },
        fixedInputs(16, 8)
      )
    ).toEqual({ deferred: false })
  })

  it('defers with measured details when 1-min load exceeds limit × cpus', () => {
    expect(
      shouldDeferStartupCommand(
        { ORCA_STARTUP_COMMAND_MAX_LOAD_PER_CPU: '2' },
        fixedInputs(16.5, 8)
      )
    ).toEqual({ deferred: true, load1: 16.5, limit: 16, cpuCount: 8 })
  })

  it('never defers on a non-finite loadavg reading', () => {
    expect(
      shouldDeferStartupCommand(
        { ORCA_STARTUP_COMMAND_MAX_LOAD_PER_CPU: '2' },
        { loadavg: () => [Number.NaN], cpuCount: 8, platform: 'darwin' }
      )
    ).toEqual({ deferred: false })
  })

  it('never defers on win32: os.loadavg() there is [0,0,0], so the gate cannot engage', () => {
    // Even a high mocked load and a low limit must not defer on win32 —
    // the disablement is explicit, not dependent on the (always-zero) reading.
    expect(
      shouldDeferStartupCommand(
        { ORCA_STARTUP_COMMAND_MAX_LOAD_PER_CPU: '0.1' },
        fixedInputs(99, 8, 'win32')
      )
    ).toEqual({ deferred: false })
  })
})

// Why an integration test on top of the unit tests: the gate only protects the
// loop described in #19828 if the delivery site actually consults it — a pure
// unit test cannot catch a wiring regression.
describe('TerminalHost startup command load gate', () => {
  const ENV_KEY = 'ORCA_STARTUP_COMMAND_MAX_LOAD_PER_CPU'
  const originalEnvValue = process.env[ENV_KEY]

  let sub: SubprocessHandle
  let host: TerminalHost
  let readinessEvents: Array<{ event: string; details: Record<string, unknown> }>

  beforeEach(() => {
    // Why: a runner-provided value would flip the "not configured" test.
    delete process.env[ENV_KEY]
    sub = mockSubprocess()
    readinessEvents = []
    host = new TerminalHost({
      spawnSubprocess: () => sub,
      reportReadinessEvent: (event, details) => readinessEvents.push({ event, details })
    })
  })

  afterEach(() => {
    if (originalEnvValue === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = originalEnvValue
  })

  it('delivers the startup command when the gate is not configured', async () => {
    await host.createOrAttach({
      sessionId: 's-nogate',
      cols: 80,
      rows: 24,
      command: 'claude',
      shellReadySupported: false,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    // POSIX submits with LF, Windows with CR — mirror the delivery site.
    const submit = process.platform === 'win32' ? 'claude\r' : 'claude\n'
    expect(vi.mocked(sub.write)).toHaveBeenCalledWith(submit)
  })

  it('defers delivery without writing anything to the shell when load exceeds the limit', async () => {
    process.env[ENV_KEY] = '2' // limit = 2 × 8 = 16, mocked loadavg(1m) = 99
    await host.createOrAttach({
      sessionId: 's-gated',
      cols: 80,
      rows: 24,
      command: 'run-heavy-tests',
      shellReadySupported: false,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    // The session must be left a pristine idle shell: no command, no notice —
    // anything written here goes to the child's stdin and would execute.
    expect(vi.mocked(sub.write).mock.calls).toHaveLength(0)
    const delivery = readinessEvents.find((e) => e.event === 'startup-command-delivery')
    expect(delivery?.details.written).toBe(false)
    expect(delivery?.details.deferredByLoad).toBe(true)
    const deferred = readinessEvents.find((e) => e.event === 'startup-command-deferred-load')
    expect(deferred).toBeDefined()
    expect(deferred?.details.commandLength).toBe('run-heavy-tests'.length)
    expect(deferred?.details.load1).toBe(99)
  })
})
