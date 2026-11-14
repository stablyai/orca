import { expect, it } from 'vitest'
import { inSessionParseFileLane } from './session-parse-file-lane'

it('cancels a queued list promptly while retaining its link behind the draining pass', async () => {
  let release!: () => void
  let entered!: () => void
  const holding = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const pass = inSessionParseFileLane('cancelled-waiter', async () => {
    entered()
    await holding
  })
  await started
  const controller = new AbortController()
  const cancelled = inSessionParseFileLane(
    'cancelled-waiter',
    async () => {
      throw new Error('Cancelled waiter ran')
    },
    controller.signal
  )
  controller.abort()
  await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  let thirdEntered = false
  const third = inSessionParseFileLane('cancelled-waiter', async () => {
    thirdEntered = true
  })
  await Promise.resolve()
  expect(thirdEntered).toBe(false)
  release()
  await Promise.all([pass, third])
  expect(thirdEntered).toBe(true)
})
