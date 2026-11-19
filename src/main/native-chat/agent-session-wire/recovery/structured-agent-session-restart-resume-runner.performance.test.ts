import type * as Os from 'node:os'
import { expect, it, vi } from 'vitest'

// Perf contract (#43707): after an update, every chat continued at once and ownership reads timed out together
// (#42760). On a many-core host the cap, not the core count, must bound a restart burst.
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof Os>()),
  availableParallelism: () => 32
}))

it('starts at most six restart continuations at once on a many-core host', async () => {
  const { StructuredAgentSessionResumeAdmission } =
    await import('./structured-agent-session-restart-resume-runner')
  const admission = new StructuredAgentSessionResumeAdmission()
  let running = 0
  let peak = 0
  let open: () => void = () => {}
  // Every continuation holds until the gate opens, so all that admission lets start are running at once.
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  const all = Promise.all(
    Array.from({ length: 25 }, (_, index) =>
      admission.run(`session-${index}`, 'restart', async () => {
        running += 1
        peak = Math.max(peak, running)
        await gate
        running -= 1
      })
    )
  )
  // Admission is all promises: let it settle without any clock, real or fake.
  for (let turn = 0; turn < 50 && running < 6; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  open()
  await all
  expect(peak).toBe(6)
})
