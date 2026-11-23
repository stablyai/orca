import { describe, expect, it, vi } from 'vitest'
import { postFailedBotWorkerStart } from './bot-worker-start-failure'

const slackTurn = {
  botId: 'bot_1',
  address: { source: 'slack' as const, externalId: 'T1:C1:1.0' }
}

describe('postFailedBotWorkerStart', () => {
  it('posts a task-keyed failure to the Slack thread', async () => {
    const post = vi.fn().mockResolvedValue(undefined)

    await postFailedBotWorkerStart(
      slackTurn,
      { taskId: 'task_1', reason: 'the agent was unavailable', machine: 'Build Box' },
      post,
      'someone_else'
    )
    await postFailedBotWorkerStart(
      slackTurn,
      { taskId: 'task_1', reason: 'the agent was unavailable', machine: 'Build Box' },
      post,
      'someone_else'
    )

    expect(post).toHaveBeenCalledTimes(2)
    expect(post).toHaveBeenNthCalledWith(1, {
      replyId: 'worker-start-failed:task_1',
      conversation: slackTurn.address,
      text: "I couldn't start the worker on Build Box: the agent was unavailable. Please retry it or check the bot's Chat.",
      turnFor: 'someone_else'
    })
    expect(post).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ replyId: 'worker-start-failed:task_1' })
    )
  })

  it('does not post for another source', async () => {
    const post = vi.fn().mockResolvedValue(undefined)

    await postFailedBotWorkerStart(
      { ...slackTurn, address: { source: 'github', externalId: 'o/r#1' } },
      { taskId: 'task_1', reason: 'the agent was unavailable', machine: 'Build Box' },
      post,
      'someone_else'
    )

    expect(post).not.toHaveBeenCalled()
  })

  it('does not post a request that originated in Orca', async () => {
    const post = vi.fn().mockResolvedValue(undefined)

    await postFailedBotWorkerStart(
      { ...slackTurn, askedInApp: true },
      { taskId: 'task_1', reason: 'the agent was unavailable', machine: 'Build Box' },
      post,
      'someone_else'
    )

    expect(post).not.toHaveBeenCalled()
  })
})
