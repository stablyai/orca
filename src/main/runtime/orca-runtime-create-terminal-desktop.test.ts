import { expect, it, vi } from 'vitest'
import { wireHeadlessServeRuntime } from './orca-runtime-test-scenario-builders.spec'

it('tells a workspace-less create on a windowless host to pass --worktree', async () => {
  const runtime = wireHeadlessServeRuntime()
  const spawn = vi.fn()
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })

  await expect(runtime.createTerminal(undefined, { title: 'probe' })).rejects.toThrow(
    /No workspace was given or found.*Pass --worktree.*No terminal was created\./
  )
  expect(spawn).not.toHaveBeenCalled()
})
