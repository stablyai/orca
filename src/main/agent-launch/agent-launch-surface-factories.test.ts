import { expect, it } from 'vitest'
import { terminalLaunchInputs } from './agent-launch-surface-factories'

it("keeps a dima chat's model id out of a terminal, which would read it as a provider", () => {
  const target = { kind: 'existing' as const, worktree: 'id:w' }
  const terminalModel = (intent: Parameters<typeof terminalLaunchInputs>[0]) =>
    terminalLaunchInputs(intent).options?.model
  expect([
    terminalModel({
      agent: 'dima',
      target,
      surface: 'chat',
      sessionOptions: { model: 'vendor/chat-two' }
    }),
    terminalModel({
      agent: 'dima',
      target,
      surface: 'chat',
      sessionOptions: { model: 'p2/vendor/chat-two' },
      chatOptions: { model: 'vendor/chat-two' }
    }),
    terminalModel({ agent: 'dima', target, sessionOptions: { model: 'p2/vendor/chat-two' } })
  ]).toEqual([undefined, 'p2/vendor/chat-two', 'p2/vendor/chat-two'])
})
