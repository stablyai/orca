import { describe, expect, it } from 'vitest'
import './runtime-test-module-registration.spec'
import '../../git/worktrees/catalog/worktree-scan-cache'
import { createRuntime, syncSinglePty } from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('resolves tui-idle when a completion title is coalesced with the next working title', async () => {
    // A coalesced done/working chunk must still expose the idle transition (#1083).
    const runtime = createRuntime()
    syncSinglePty(runtime)
    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
    const [terminal] = (await runtime.listTerminals()).terminals
    const wait = runtime.waitForTerminal(terminal.handle, {
      condition: 'tui-idle',
      timeoutMs: 1_000
    })

    runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07\x1b]0;Codex working\x07', 101)

    await expect(wait).resolves.toMatchObject({
      handle: terminal.handle,
      condition: 'tui-idle',
      status: 'running'
    })
  })
})
