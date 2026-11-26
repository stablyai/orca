import { expect, it, vi } from 'vitest'
import { createAgentOrchestrationChangeNotice } from './agent-orchestration-change-notice'

it('sends one notice for several Dispatch writes in one tick, and another for a later tick', async () => {
  const emit = vi.fn()
  const note = createAgentOrchestrationChangeNotice(emit)
  note()
  note()
  note()
  expect(emit).not.toHaveBeenCalled()
  await Promise.resolve()
  expect(emit).toHaveBeenCalledTimes(1)
  note()
  await Promise.resolve()
  expect(emit).toHaveBeenCalledTimes(2)
})
