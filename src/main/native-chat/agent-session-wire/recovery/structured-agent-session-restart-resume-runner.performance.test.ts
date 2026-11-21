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

it('gives chats cut mid-turn the start slots before chats whose lead had finished', async () => {
  const { StructuredAgentSessionResumeAdmission, resumeStructuredAgentSessionsFromRestart } =
    await import('./structured-agent-session-restart-resume-runner')
  const started: string[] = []
  let open: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    open = resolve
  })
  const candidate = (sessionId: string, state: 'done' | 'working') => ({
    sessionId,
    workspaceId: 'repo::/repo',
    agent: 'claude',
    work: { kind: 'turn' as const, id: 'turn-1' },
    trigger: 'update' as const,
    recordedAt: 1,
    latestPrompt: '',
    executionHostId: 'local' as const,
    workspaceKind: 'git-worktree' as const,
    activity: { state, prompts: [], tasks: [{ kind: 'command' as const, label: 'watch' }] }
  })
  // One restart owing 20 chats whose lead had finished, listed before the 3 cut mid-turn.
  const candidates = [
    ...Array.from({ length: 20 }, (_, index) => candidate(`finished-${index}`, 'done')),
    ...['mid-0', 'mid-1', 'mid-2'].map((id) => candidate(id, 'working'))
  ]
  const all = resumeStructuredAgentSessionsFromRestart(
    {
      admission: new StructuredAgentSessionResumeAdmission(),
      consumeMarker: async () => true,
      resume: async (sessionId) => {
        started.push(sessionId)
        await gate
      }
    },
    candidates,
    'launch'
  )
  for (let turn = 0; turn < 50 && started.length < 6; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  expect(started.slice(0, 3)).toEqual(['mid-0', 'mid-1', 'mid-2'])
  expect(started).toHaveLength(6)
  open()
  await all
  expect(started).toHaveLength(23)
})
