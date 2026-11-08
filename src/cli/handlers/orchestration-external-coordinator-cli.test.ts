import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const getTerminalHandleMock = vi.hoisted(() => vi.fn())
vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: getTerminalHandleMock }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { ORCHESTRATION_EXTERNAL_COORDINATOR_RUNTIME_CAPABILITY } from '../../shared/orchestration/orchestration-runtime-capabilities'

const ORCA_ENV = [
  'ORCA_TERMINAL_HANDLE',
  'ORCA_PANE_KEY',
  'ORCA_AGENT_LAUNCH_TOKEN',
  'ORCA_AGENT_SESSION_ID'
]
const originalEnv = Object.fromEntries(ORCA_ENV.map((name) => [name, process.env[name]]))

type SavedEnvironmentClient = { call: typeof callMock; environmentSelector: string; isRemote: true }

function savedEnvironmentClient(supported: boolean, result: unknown): SavedEnvironmentClient {
  callMock.mockImplementation((method: string) =>
    method === 'status.get'
      ? {
          result: {
            capabilities: supported ? [ORCHESTRATION_EXTERNAL_COORDINATOR_RUNTIME_CAPABILITY] : []
          }
        }
      : { result }
  )
  return { call: callMock, environmentSelector: 'this-mac', isRemote: true }
}

function invoke(
  command: string,
  flags: [string, string | boolean][],
  client: SavedEnvironmentClient
) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers use only client.call, environmentSelector and isRemote, all supplied by the fixture.
  return ORCHESTRATION_HANDLERS[command]({
    flags: new Map<string, string | boolean>([...flags, ['json', true]]),
    client,
    cwd: '/tmp/repo',
    json: true
  } as never)
}

const callsTo = (method: string) => callMock.mock.calls.filter(([name]) => name === method)

describe('external coordinator CLI identity', () => {
  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    for (const name of ORCA_ENV) {
      delete process.env[name]
    }
  })

  afterEach(() => {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  })

  it('creates an external Run without resolving a terminal', async () => {
    await invoke(
      'orchestration run-create',
      [
        ['objective', 'Nightly'],
        ['external', true]
      ],
      savedEnvironmentClient(true, {
        run: { id: 'run_ext', objective: 'Nightly', consumer_generation: 1 }
      })
    )

    expect(callMock).toHaveBeenCalledWith('orchestration.runCreate', {
      objective: 'Nightly',
      external: true
    })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()
  })

  it('refuses run-create --external when the runtime cannot bind an external coordinator', async () => {
    await expect(
      invoke(
        'orchestration run-create',
        [
          ['objective', 'Nightly'],
          ['external', true]
        ],
        savedEnvironmentClient(false, {})
      )
    ).rejects.toMatchObject({ code: 'external_coordinator_unsupported' })
    expect(callsTo('orchestration.runCreate')).toEqual([])
  })

  it('checks as the paired device outside a terminal, and as the terminal inside one', async () => {
    const client = savedEnvironmentClient(true, { messages: [], count: 0, runId: 'run_ext' })

    await invoke('orchestration check', [], client)
    expect(callsTo('orchestration.check')[0]?.[1]).toMatchObject({ terminal: undefined })
    expect(getTerminalHandleMock).not.toHaveBeenCalled()

    process.env.ORCA_TERMINAL_HANDLE = 'term_inside'
    await invoke('orchestration check', [], client)
    expect(callsTo('orchestration.check')[1]?.[1]).toMatchObject({ terminal: 'term_inside' })
  })
})
