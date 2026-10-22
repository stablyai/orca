import { describe, expect, it } from 'vitest'

/**
 * Keep the agent SDK on the structured-Claude side of the toggle.
 *
 * A user who never leaves the terminal/TUI Claude path must not pay for the SDK:
 * importing it evaluates a package that rewrites
 * `process.env.NoDefaultCurrentDirectoryInExePath`, changing how Windows resolves
 * executables for every later subprocess. Loading the structured runtime must not
 * trip that rewrite, which is only true while the SDK stays behind a deferred
 * import inside the session path.
 */
describe('claude agent SDK import boundary', () => {
  it('leaves the Windows executable-search environment alone when the runtime loads', async () => {
    // A vitest file runs in its own fork, so this is a clean process; the ambient
    // value is cleared first because the developer's own shell may carry one.
    delete process.env.NoDefaultCurrentDirectoryInExePath
    await import('../runtime/structured-agent-session-runtime')

    expect(process.env.NoDefaultCurrentDirectoryInExePath).toBeUndefined()
  })
})
