import { afterEach, expect, it, vi } from 'vitest'
import { resolveRpcWorkOrigin } from './work-origin-context'
import { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { TERMINAL_METHODS } from './methods/terminal'
import { RpcDispatcher } from './dispatcher'
import type { OrcaRuntimeService } from '../orca-runtime'

const origin = { kind: 'paired-device', deviceId: 'desktop-a' } as const

afterEach(() => setStructuredAgentSessionHost(null))

it('inherits a parent run instead of attributing its CLI connection', () => {
  const runtime = { getTerminalWorkOrigin: vi.fn(() => origin) } as unknown as OrcaRuntimeService
  const context = { runtime, pairedDeviceId: 'cli-device', clientKind: 'runtime' as const }
  expect(
    resolveRpcWorkOrigin(context, { callerTerminalHandle: 'parent', cliProvenanceRequest: {} })
  ).toEqual(origin)
  expect(resolveRpcWorkOrigin(context)).toEqual({ kind: 'paired-device', deviceId: 'cli-device' })
  expect(resolveRpcWorkOrigin(context, { cliProvenanceRequest: {} })).toBeNull()
})

it('validates native child origin against the live lease for terminal splits', async () => {
  const host = Object.create(StructuredAgentSessionHost.prototype) as StructuredAgentSessionHost
  Object.assign(host, {
    deps: {
      store: {
        getRecord: (id: string) =>
          id === 'session-a'
            ? {
                workOrigin: origin,
                lease: { claimStatus: 'live', ownerProcess: { spawnToken: 'current-token' } }
              }
            : null
      }
    }
  })
  setStructuredAgentSessionHost(host)
  const splitTerminal = vi.fn(async () => ({ handle: 'child' }))
  const runtime = { splitTerminal, getRuntimeId: () => 'host' } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  for (const spawnToken of ['current-token', 'stale-token']) {
    await dispatcher.dispatch({
      id: spawnToken,
      authToken: 'token',
      method: 'terminal.split',
      params: {
        terminal: 'target-pane',
        cliProvenanceRequest: {},
        callerOriginSession: { sessionId: 'session-a', spawnToken }
      }
    })
    expect(splitTerminal).toHaveBeenLastCalledWith(
      'target-pane',
      expect.objectContaining({ workOrigin: spawnToken === 'current-token' ? origin : null })
    )
  }
})
