import { expect, it } from 'vitest'
import { agentStartsInFlight, trackAgentStart } from './agent-start-activity'

it('counts agent starts while they run', async () => {
  let release: () => void = () => {}
  const start = trackAgentStart(() => new Promise<void>((resolve) => (release = resolve)))
  expect(agentStartsInFlight()).toBe(1)
  release()
  await start
  expect(agentStartsInFlight()).toBe(0)
})

it('releases the count when a start throws', async () => {
  await expect(
    trackAgentStart(async () => {
      throw new Error('spawn failed')
    })
  ).rejects.toThrow('spawn failed')
  expect(agentStartsInFlight()).toBe(0)
})
