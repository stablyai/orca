// A call to a shared agent on a link that isn't live waits for the share list to say whether the owner
// stopped sharing it: for that list only, and never longer than its cap.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NODE_RELAY_CLIENT_PLATFORM } from '../../../shared/remote-runtime/relay/client/node/node-relay-client-platform'
import {
  SHARED_BOT_HOST_ERRORS,
  SHARED_BOT_UNSHARED_MESSAGE
} from '../../../shared/bots/shared-bot-hosts'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { SharedBotHosts } from './shared-bot-hosts'
import type { MineShare } from './shared-bot-pairing'
import type { SharedBotsCloud } from './shared-bots-cloud'
import { memorySharedBotHomes } from './shared-bot-home.test-fixture'

const dirs: string[] = []
afterEach(() => {
  vi.useRealTimers()
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
  state: 'needs-accept',
  held: []
})

const never = <T>() => new Promise<T>(() => {})

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
    hold: async () => ({ ok: true, value: { status: 'held' } })
  }
  return new SharedBotHosts({
    userDataPath: dir,
    account: () => 'ada',
    cloud: () => sharesCloud,
    platform: NODE_RELAY_CLIENT_PLATFORM,
    publish: () => {},
    homes: memorySharedBotHomes(dir).homes,
    now: () => 1_000
  })
}

const errorOf = (response: RuntimeRpcResponse<unknown>) => (response.ok ? null : response.error)
const unshared = { code: SHARED_BOT_HOST_ERRORS.unshared, message: SHARED_BOT_UNSHARED_MESSAGE }

describe('a call to a shared agent whose owner stopped sharing it', () => {
  it('answers no longer shared while the cloud read that drops the share is out, and after', async () => {
    let answer: ((shares: MineShare[]) => void) | null = null
    let mine: () => MineShare[] | Promise<MineShare[]> = () => [share('a')]
    const service = hosts({ mine: () => mine(), accept: async () => {} })
    await service.refresh()
    const { environmentId } = service.views()[0]!
    mine = () => new Promise((resolve) => (answer = resolve))
    const read = service.refresh()
    const during = service.call(environmentId, 'bots.list', {})
    await vi.waitFor(() => expect(answer).not.toBeNull())
    answer!([])
    await read
    const after = await service.call(environmentId, 'bots.list', {})
    service.stop()
    expect([errorOf(await during), errorOf(after)]).toEqual([unshared, unshared])
    expect(service.reaches(environmentId)).toBe(true)
  })

  it('answers once the list is applied, not after another share’s pairing that never ends', async () => {
    let mine = [share('a')]
    const service = hosts({
      mine: () => mine,
      accept: (shareId) => (shareId === 'b' ? never() : Promise.resolve())
    })
    await service.refresh()
    const { environmentId } = service.views()[0]!
    mine = [share('b')]
    void service.refresh()
    const answer = await service.call(environmentId, 'bots.list', {})
    service.stop()
    expect(errorOf(answer)).toEqual(unshared)
  })

  it('waits at most its cap for a cloud read that never answers, then reads as offline', async () => {
    let mine: () => MineShare[] | Promise<MineShare[]> = () => [share('a')]
    const service = hosts({ mine: () => mine(), accept: async () => {} })
    await service.refresh()
    const { environmentId } = service.views()[0]!
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    mine = never
    void service.refresh()
    const answer = service.call(environmentId, 'bots.list', {})
    await vi.advanceTimersByTimeAsync(5_000)
    service.stop()
    expect(errorOf(await answer)?.code).toBe(SHARED_BOT_HOST_ERRORS.offline)
  })
})
