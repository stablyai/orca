/**
 * The zsh arm of `structured-session-cli-login-shell.test.ts`: Codex's own shell on macOS. Runs in
 * the real-shell lane, which installs zsh; the ordinary unit lane has none.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createLoginShellHarness,
  type LoginShellHarness
} from './structured-session-login-shell-test-harness'

describe.runIf(process.platform !== 'win32')('a structured session in a zsh login shell', () => {
  let harness: LoginShellHarness

  beforeEach(() => {
    harness = createLoginShellHarness()
  })

  afterEach(() => {
    harness.dispose()
  })

  it("resolves this app's CLI through ORCA_CLI_COMMAND in `zsh -lc`", async () => {
    // Positive control: the profile really does put the global install first for a bare name.
    expect(await harness.run({ program: '/bin/zsh', args: ['-lc', 'orca'] })).toBe('global')
    expect(await harness.run({ program: '/bin/zsh', args: ['-lc', '"$ORCA_CLI_COMMAND"'] })).toBe(
      'app'
    )
  })

  it("keeps bare `orca` this app's CLI in a zsh that reads no login profile", async () => {
    expect(await harness.run({ program: '/bin/zsh', args: ['-c', 'orca'] })).toBe('app')
  })
})
