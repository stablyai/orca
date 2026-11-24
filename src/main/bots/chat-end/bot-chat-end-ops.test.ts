// An op id is reserved across every bot's lane the moment it arrives.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotChatEndResult } from '../../../shared/bots/bot-chat-end'
import {
  BotChatEndOpConflict,
  resetBotChatEndOpsForTests,
  runBotChatEndOp
} from './bot-chat-end-ops'

const ENDED: BotChatEndResult = { outcome: 'ended', title: null }

beforeEach(() => {
  resetBotChatEndOpsForTests()
})

describe('an end op id', () => {
  it('runs once when the same op arrives on two bots’ lanes at once', async () => {
    let finish: (result: BotChatEndResult) => void = () => {}
    const run = vi.fn(() => new Promise<BotChatEndResult>((resolve) => (finish = resolve)))
    const op = (botId: string) => ({ opId: 'op-1', key: 'same', botId, now: () => 0 })

    const first = runBotChatEndOp(op('bot-a'), run)
    const second = runBotChatEndOp(op('bot-b'), run)
    await Promise.resolve()
    finish(ENDED)

    expect(await first).toEqual(ENDED)
    expect(await second).toEqual(ENDED)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('refuses another request under an id still running, on any lane', async () => {
    const run = vi.fn(() => new Promise<BotChatEndResult>(() => {}))
    void runBotChatEndOp({ opId: 'op-2', key: 'a', botId: 'bot-a', now: () => 0 }, run)

    await expect(
      runBotChatEndOp({ opId: 'op-2', key: 'b', botId: 'bot-b', now: () => 0 }, run)
    ).rejects.toBeInstanceOf(BotChatEndOpConflict)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('lets an id whose op failed run again', async () => {
    const op = { opId: 'op-3', key: 'a', botId: 'bot-a', now: () => 0 }
    await expect(runBotChatEndOp(op, () => Promise.reject(new Error('no host')))).rejects.toThrow()

    expect(await runBotChatEndOp(op, async () => ENDED)).toEqual(ENDED)
  })
})
