import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer, classifyRuntimeLongPoll } from './runtime-rpc'
import { configuredLongPollCap } from './runtime-rpc/runtime-rpc-long-poll'

afterEach(() => vi.unstubAllEnvs())

it.each(['', '0', '-1', '1.5', 'NaN', 'Infinity'])(
  'uses the default for an invalid configured cap (%s)',
  (value) => {
    vi.stubEnv('ORCA_RPC_LONG_POLL_CAP', value)
    expect(configuredLongPollCap()).toBe(16)
  }
)

it('reserves launch capacity when check, ask and browser-host polls combine', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-check-admission-'))
  vi.stubEnv('ORCA_RPC_LONG_POLL_CAP', '8')
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath: directory,
    methods: []
  })
  try {
    const check = classifyRuntimeLongPoll({
      id: 'check',
      authToken: 'token',
      method: 'orchestration.check',
      params: { wait: true }
    })
    for (let index = 0; index < 4; index++) {
      expect(server['admitLongPoll'](check)).toBeNull()
    }
    expect(server['admitLongPoll'](check)).toContain(
      'orchestration.check capacity reached (4/8 in use; check=4/4'
    )
    expect(server['admitLongPoll']('ask')).toBeNull()
    expect(server['admitLongPoll']('browser-host')).toBeNull()
    expect(server['admitLongPoll']('ask')).toContain('capacity reached')
    const launch = classifyRuntimeLongPoll({
      id: 'start',
      authToken: 'token',
      method: 'orchestration.workerStart'
    })
    expect(server['admitLongPoll'](launch)).toBeNull()
    expect(server['admitLongPoll'](launch)).toBeNull()
    expect(server['admitLongPoll'](launch)).toContain(
      'long-poll capacity reached (8/8 in use; check=4/4'
    )
    expect(server['admitLongPoll'](null)).toBeNull()
    server['releaseLongPoll'](check)
    expect(server['admitLongPoll'](check)).toBeNull()
    server['releaseLongPoll'](check)
    expect(server['activeCheckLongPolls']).toBe(3)
    expect(server['activeLongPolls']).toBe(7)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('lets an explicit server cap override the environment', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-check-cap-'))
  vi.stubEnv('ORCA_RPC_LONG_POLL_CAP', '64')
  try {
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath: directory,
      longPollCap: 4,
      methods: []
    })
    expect(server['admitLongPoll']('check')).toBeNull()
    expect(server['admitLongPoll']('check')).toBeNull()
    expect(server['admitLongPoll']('check')).toContain('check=2/2')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
