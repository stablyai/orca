import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/connection/types'
import { ENVIRONMENT_HANDLERS } from './environment'

const printResultMock = vi.hoisted(() => vi.fn())

vi.mock('../output/command-result-output', () => ({ printResult: printResultMock }))

function fakeClient(call: (method: string, params?: unknown) => Promise<unknown>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handlers only use call.
  return { call } as unknown as HandlerContext['client']
}

function handlerContext(
  flags: [string, string | boolean][],
  client: HandlerContext['client']
): HandlerContext {
  return { flags: new Map(flags), client, cwd: '/tmp/repo', json: true }
}

function ok(result: unknown) {
  return { id: 'req', ok: true, result, _meta: { runtimeId: 'local' } }
}

const confirmed: [string, string | boolean][] = [
  ['environment', 'box-a'],
  ['yes', true]
]
const unconfirmed: [string, string | boolean][] = [['environment', 'box-a']]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('host stop / host forget', () => {
  it('demands --yes before it reaches the runtime', async () => {
    const client = fakeClient(async () => {
      throw new Error('must not call the runtime')
    })

    for (const command of ['host stop', 'host forget']) {
      await expect(
        ENVIRONMENT_HANDLERS[command](handlerContext(unconfirmed, client))
      ).rejects.toMatchObject({ code: 'confirmation_required' })
    }
  })

  it('reports a refused stop as an error, never as a success', async () => {
    const client = fakeClient(async () =>
      ok({ outcome: 'refused', verdict: 'live', code: 'orcad_stop_live', reason: 'Terminals' })
    )

    await expect(
      ENVIRONMENT_HANDLERS['host stop'](handlerContext(confirmed, client))
    ).rejects.toMatchObject({ code: 'managed_server_refused' })
    expect(printResultMock).not.toHaveBeenCalled()
  })

  it('points a runtime without the local forget at the desktop command', async () => {
    const client = fakeClient(async () =>
      ok({
        outcome: 'refused',
        verdict: 'unverifiable',
        code: 'managed_server_unavailable',
        reason: 'Not wired'
      })
    )

    const error: unknown = await ENVIRONMENT_HANDLERS['host forget'](
      handlerContext(confirmed, client)
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(RuntimeClientError)
    if (!(error instanceof RuntimeClientError)) {
      throw new Error('expected a refusal error')
    }
    expect(error.code).toBe('managed_server_refused')
    expect(error.message).toContain('orca environment forget')
    expect(error.message).not.toContain('Update Orca')
    expect(printResultMock).not.toHaveBeenCalled()
  })

  it('names an older runtime when the local forget method is missing', async () => {
    const client = fakeClient(async () => {
      throw new RuntimeClientError('method_not_found', 'Unknown method: managedServer.forgetLocal')
    })

    await expect(
      ENVIRONMENT_HANDLERS['host forget'](handlerContext(confirmed, client))
    ).rejects.toMatchObject({ code: 'incompatible_runtime' })
  })
})
