import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { initDataPath } from '../../../persistence/loading-store/user-data-path'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { BOT_MEMORY_METHODS } from './bots-memory'

describe('bot memory commands', () => {
  it.each([
    ['bots.memory.edit', { botId: 'b1', text: 'releases go out on Wednesdays' }, 'change'],
    ['bots.memory.forget', { botId: 'b1', fact: 'releases go out on Wednesdays' }, 'forget'],
    ['bots.memory.undo', { botId: 'b1', id: 'row-1' }, 'undo']
  ] as const)('%s changes the memory in the bot home', async (method, params, call) => {
    installFakeAppEnvironment({ getPath: () => join('/isolated', 'profile') })
    initDataPath()
    const memory = {
      change: vi.fn(async () => {}),
      forget: vi.fn(async () => true),
      undo: vi.fn(async () => true)
    }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      bots: { assertEnabled: () => {}, list: () => [makeTestBot({ id: 'b1' })], memory }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these methods read only runtime.bots, which the stub provides.
    const service = runtime as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime: service, methods: BOT_MEMORY_METHODS })

    const response = await dispatcher.dispatch({
      id: 'req-1',
      authToken: 'test-token',
      method,
      params
    })

    expect(response).toMatchObject({ ok: true })
    expect(memory[call]).toHaveBeenCalledWith(
      'b1',
      join('/isolated', 'profile', 'bots', 'reviewer'),
      ...(call === 'undo' ? ['row-1'] : [expect.anything(), expect.anything()])
    )
  })
})
