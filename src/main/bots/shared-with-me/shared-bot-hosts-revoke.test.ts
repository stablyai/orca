// A call to a shared agent whose owner stopped sharing it is answered here as no longer shared, never
// sent to the host as a paired server's call (which would read as an unknown server).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SHARED_BOT_HOST_ERRORS,
  SHARED_BOT_UNSHARED_MESSAGE
} from '../../../shared/bots/shared-bot-hosts'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { SharedBotHosts } from './shared-bot-hosts'
import type { MineShare } from './shared-bot-pairing'
import type { SharedBotsCloud } from './shared-bots-cloud'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const share = (shareId: string): MineShare => ({
  shareId,
  botId: `bot-${shareId}`,
  botName: 'Ivy',
  ownerName: 'Jinwoo Hong',
  hostOnline: true,
  state: 'ready',
  held: []
})

/** The account's shared hosts over a cloud whose list and accepts answer as each test says. */
function hosts(cloud: {
  mine: () => MineShare[] | Promise<MineShare[]>
  accept: (shareId: string) => Promise<void>
}) {
  const dir = mkdtempSync(join(tmpdir(), 'shared-bot-revoke-'))
  dirs.push(dir)
  const sharesCloud: SharedBotsCloud = {
    mine: async () => ({ ok: true, value: { v: 1, shares: await cloud.mine() } }),
    accept: async (shareId) => {
      await cloud.accept(shareId)
      return { ok: true, value: { status: 'queued' } }
    },
    decline: async () => ({ ok: true, value: { status: 'declined' } }),
    hold: async () => ({ ok: true, value: { status: 'held' } })
  }
  return new SharedBotHosts({
    userDataPath: dir,
    account: () => 'ada',
    cloud: () => sharesCloud,
    publish: () => {},
    now: () => 1_000
  })
}

const errorOf = (response: RuntimeRpcResponse<unknown>) => (response.ok ? null : response.error)
const unshared = { code: SHARED_BOT_HOST_ERRORS.unshared, message: SHARED_BOT_UNSHARED_MESSAGE }

const sendNever = () => Promise.reject(new Error('sent to the host'))

describe('a call to a shared agent whose owner stopped sharing it', () => {
  it('answers no longer shared once the share list drops it, and sends a kept share’s calls on', async () => {
    let mine = [share('a')]
    const service = hosts({ mine: () => mine, accept: async () => {} })
    await service.refresh()
    const { environmentId } = service.views()[0]!
    // Kept: the paired path sends it.
    expect(await service.answerHere(environmentId, 'bots.list', {}, sendNever)).toBeNull()
    mine = []
    await service.refresh()
    const after = await service.answerHere(environmentId, 'bots.list', {}, sendNever)
    service.stop()
    expect(after && errorOf(after)).toEqual(unshared)
    // Never one of these shares: the paired path answers it as any other server.
    expect(await service.answerHere('env-unknown', 'bots.list', {}, sendNever)).toBeNull()
  })
})
