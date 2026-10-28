import { expect, it } from 'vitest'
import { wireHeadlessServeRuntime } from './orca-runtime-test-scenario-builders.spec'

it('tells a workspace-less create on a windowless host to pass --worktree', async () => {
  const runtime = wireHeadlessServeRuntime()

  await expect(runtime.createTerminal(undefined, { title: 'probe' })).rejects.toThrow(
    /No workspace was given or found.*Pass --worktree.*No terminal was created\./
  )
})
