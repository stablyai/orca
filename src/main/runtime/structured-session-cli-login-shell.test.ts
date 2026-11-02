/** Login profiles can put global Orca ahead on PATH; absolute ORCA_CLI_COMMAND must still reach this app. zsh runs in the real-shell lane. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createLoginShellHarness,
  type LoginShellHarness
} from './structured-session-login-shell-test-harness'

describe.runIf(process.platform !== 'win32')('a structured session in a bash login shell', () => {
  let harness: LoginShellHarness

  beforeEach(() => {
    harness = createLoginShellHarness()
  })

  afterEach(() => {
    harness.dispose()
  })

  it("resolves this app's CLI through ORCA_CLI_COMMAND in `bash -lc`", async () => {
    // Positive control: the profile really does put the global install first for a bare name.
    expect(await harness.run({ program: '/bin/bash', args: ['-lc', 'orca'] })).toBe('global')
    expect(await harness.run({ program: '/bin/bash', args: ['-lc', '"$ORCA_CLI_COMMAND"'] })).toBe(
      'app'
    )
  })

  it("keeps bare `orca` this app's CLI in a shell that reads no login profile", async () => {
    expect(await harness.run({ program: '/bin/bash', args: ['-c', 'orca'] })).toBe('app')
  })
})
