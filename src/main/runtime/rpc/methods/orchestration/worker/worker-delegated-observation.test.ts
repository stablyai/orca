import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { identity as baseIdentity } from '../../../../../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import { reserveDelegatedPtyProviderRoute } from '../../../../../ipc/pty/provider/delegated-provider-routes'
import { inspectWorkerTerminal } from './worker-observation'

it.each(['exact', 'wrong-incarnation', 'wrong-runtime'] as const)(
  'uses only an exact host reservation for an unreadable delegated worker: %s',
  async (variant) => {
    const identity = { ...baseIdentity, terminalId: randomUUID() }
    reserveDelegatedPtyProviderRoute(identity)
    const runtime = {
      showTerminal: vi.fn().mockRejectedValue(new Error('inventory unavailable')),
      getRuntimeId: () => (variant === 'wrong-runtime' ? 'other' : identity.destinationRuntimeId)
    }
    const db = {
      getWorkerDispatch: () => ({ agent_terminal_handle: 'worker' }),
      getDispatchContextById: () => ({
        process_incarnation: `${identity.terminalId}:${variant === 'wrong-incarnation' ? randomUUID() : identity.incarnationId}`
      })
    }
    const result = await inspectWorkerTerminal(runtime as never, db as never, 'dispatch')
    expect(result).toMatchObject({
      terminal: null,
      exact: false,
      status: variant === 'exact' ? 'unverifiable' : 'missing'
    })
  }
)
