import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { initDataPath } from '../../../persistence/loading-store/user-data-path'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { BotLookAroundStore } from '../../../bots/bot-look-around-store'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { BOT_TIDY_UP_METHODS } from './bots-tidy-up'

const SUMMARY = {
  at: 1,
  tookMs: 60_000,
  chats: 1,
  learned: ['releases go out on Wednesdays'],
  replaced: [],
  filed: [],
  moved: 0,
  merged: 0
}

function tidyRuntime() {
  const lookAround = new BotLookAroundStore({ read: () => null, write: async () => {} }, () => {})
  const undo = vi.fn(async () => true)
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    bots: {
      assertEnabled: () => {},
      list: () => [makeTestBot({ id: 'b1', agent: 'claude' })],
      memory: { undo, history: () => [] }
    },
    lookAround
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these methods read only runtime.bots and runtime.lookAround, which the stub provides.
  const service = runtime as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime: service, methods: BOT_TIDY_UP_METHODS })
  const lastRun = (rowId: string) =>
    lookAround.update('b1', (state) => ({
      state: { ...state, tidyUp: { runs: [], last: { ...SUMMARY, rowId } } },
      result: null
    }))
  return { dispatcher, undo, lastRun }
}

const request = (params: Record<string, unknown>) => ({
  id: 'req-1',
  authToken: 'test-token',
  method: 'bots.tidyUp.undo',
  params
})

describe('Undo of a tidy-up', () => {
  it('undoes the run the owner reviewed, never a newer one that replaced it', async () => {
    installFakeAppEnvironment({ getPath: () => join('/isolated', 'profile') })
    initDataPath()
    const { dispatcher, undo, lastRun } = tidyRuntime()
    lastRun('run-A')
    lastRun('run-B')

    expect(await dispatcher.dispatch(request({ botId: 'b1', rowId: 'run-A' }))).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('tidy_up_stale') }
    })
    expect(undo).not.toHaveBeenCalled()

    expect(await dispatcher.dispatch(request({ botId: 'b1', rowId: 'run-B' }))).toMatchObject({
      ok: true,
      result: { undone: true }
    })
    expect(undo).toHaveBeenCalledWith(
      'b1',
      join('/isolated', 'profile', 'bots', 'reviewer'),
      'run-B'
    )
  })
})
