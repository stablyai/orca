import { afterEach, expect, it, vi } from 'vitest'
import { cancelLocalGeneration } from './source-control-generation-lanes'
import { runLocalSourceControlPlan } from './source-control-local-process'

const { forceTerminateProcessTreeMock } = vi.hoisted(() => ({
  forceTerminateProcessTreeMock: vi.fn()
}))

vi.mock('../../shared/child-process/process-tree-termination', () => ({
  forceTerminateProcessTree: forceTerminateProcessTreeMock
}))

afterEach(() => forceTerminateProcessTreeMock.mockReset())

function createKnowledgeChild() {
  const listeners = new Map<string, (value: Buffer | null) => void>()
  const child = {
    pid: 41,
    stdin: { end: vi.fn() },
    stdout: { on: vi.fn((event, listener) => listeners.set(`stdout:${event}`, listener)) },
    stderr: { on: vi.fn((event, listener) => listeners.set(`stderr:${event}`, listener)) },
    on: vi.fn((event, listener) => listeners.set(event, listener)),
    off: vi.fn(),
    kill: vi.fn()
  }
  return { child, listeners }
}

it('waits for a failed knowledge agent to terminate before settling the summary', async () => {
  let completeTermination!: (verified: boolean) => void
  forceTerminateProcessTreeMock.mockReturnValue(
    new Promise<boolean>((resolve) => {
      completeTermination = resolve
    })
  )
  const { child } = createKnowledgeChild()
  const spawnAgent = vi.fn(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture provides every child member the executor accesses.
    return child as never
  })
  const execution = runLocalSourceControlPlan({
    plan: { binary: 'agent', args: [], stdinPayload: null, label: 'Agent' },
    cwd: '/repo',
    env: {},
    emptyResultName: 'knowledge summary',
    operation: 'knowledge-enrichment',
    holdHomeLockUntilExit: false,
    waitForTerminationOnFailure: true,
    spawnAgent
  })

  expect(spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ detached: true }))
  cancelLocalGeneration('knowledge-enrichment', '/repo')
  await Promise.resolve()
  expect(forceTerminateProcessTreeMock).toHaveBeenCalledWith(child)

  let settled = false
  void execution.result.then(() => {
    settled = true
  })
  await Promise.resolve()
  expect(settled).toBe(false)

  completeTermination(true)
  await expect(execution.result).resolves.toEqual({
    success: false,
    error: 'Generation canceled.',
    canceled: true
  })
})

it('does not settle an output-limited knowledge summary before tree termination', async () => {
  let completeTermination!: (verified: boolean) => void
  forceTerminateProcessTreeMock.mockReturnValue(
    new Promise<boolean>((resolve) => {
      completeTermination = resolve
    })
  )
  const { child, listeners } = createKnowledgeChild()
  const execution = runLocalSourceControlPlan({
    plan: { binary: 'agent', args: [], stdinPayload: null, label: 'Agent' },
    cwd: '/repo',
    env: {},
    emptyResultName: 'knowledge summary',
    operation: 'knowledge-enrichment',
    holdHomeLockUntilExit: false,
    waitForTerminationOnFailure: true,
    spawnAgent: vi.fn(() => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Fixture provides every child member the executor accesses.
      return child as never
    })
  })

  listeners.get('stdout:data')?.(Buffer.alloc(4 * 1024 * 1024 + 1))
  listeners.get('close')?.(null)
  let settled = false
  void execution.result.then(() => {
    settled = true
  })
  await Promise.resolve()
  expect(settled).toBe(false)

  completeTermination(false)
  await expect(execution.result).resolves.toEqual({
    success: false,
    error: 'Generation cleanup could not be verified.',
    cleanupUnverified: true
  })
})
