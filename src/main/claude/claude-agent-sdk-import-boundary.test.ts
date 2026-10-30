import { describe, expect, it } from 'vitest'

// Defer SDK loading: it mutates Windows executable-search policy even for terminal-only users.
describe('claude agent SDK import boundary', () => {
  it('leaves the Windows executable-search environment alone when the runtime loads', async () => {
    // Remove any shell-provided value before checking this isolated test process.
    delete process.env.NoDefaultCurrentDirectoryInExePath
    await import('../runtime/structured-agent-session-runtime')

    expect(process.env.NoDefaultCurrentDirectoryInExePath).toBeUndefined()
  })
})
