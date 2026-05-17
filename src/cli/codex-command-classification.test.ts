import { describe, expect, it } from 'vitest'

import { shouldForceVisibleCodexTerminal } from './codex-command-classification'

describe('shouldForceVisibleCodexTerminal', () => {
  it('forces visible terminal creation for interactive Codex sessions', () => {
    expect(shouldForceVisibleCodexTerminal('codex')).toBe(true)
    expect(shouldForceVisibleCodexTerminal('codex -m gpt-5 "fix the flaky test"')).toBe(true)
    expect(shouldForceVisibleCodexTerminal('codex resume --last')).toBe(true)
    expect(shouldForceVisibleCodexTerminal('codex fork')).toBe(true)
    expect(shouldForceVisibleCodexTerminal('codex login')).toBe(true)
    expect(shouldForceVisibleCodexTerminal('codex cloud')).toBe(true)
    expect(shouldForceVisibleCodexTerminal('codex -c active=cloud cloud')).toBe(true)
    expect(shouldForceVisibleCodexTerminal('codex.cmd resume --last')).toBe(true)
    expect(shouldForceVisibleCodexTerminal('env OPENAI_API_KEY=stub codex')).toBe(true)
  })

  it('keeps one-shot Codex commands on the background path', () => {
    expect(shouldForceVisibleCodexTerminal('codex exec summarize')).toBe(false)
    expect(shouldForceVisibleCodexTerminal('codex -m gpt-5 review')).toBe(false)
    expect(shouldForceVisibleCodexTerminal('codex login status')).toBe(false)
    expect(shouldForceVisibleCodexTerminal('codex login --with-api-key')).toBe(false)
    expect(shouldForceVisibleCodexTerminal('codex cloud list --json')).toBe(false)
    expect(shouldForceVisibleCodexTerminal('codex -c active=cloud cloud list --json')).toBe(false)
    expect(shouldForceVisibleCodexTerminal('codex cloud --enable foo list --json')).toBe(false)
    expect(
      shouldForceVisibleCodexTerminal('env -u DEBUG CODEX_HOME=/tmp/codex codex exec summarize')
    ).toBe(false)
    expect(shouldForceVisibleCodexTerminal('codex cloud exec "fix it"')).toBe(false)
    expect(shouldForceVisibleCodexTerminal('codex cloud --version')).toBe(false)
    expect(shouldForceVisibleCodexTerminal('codex --help')).toBe(false)
  })

  it('ignores non-Codex commands', () => {
    expect(shouldForceVisibleCodexTerminal(undefined)).toBe(false)
    expect(shouldForceVisibleCodexTerminal('claude')).toBe(false)
    expect(shouldForceVisibleCodexTerminal('npm exec codex')).toBe(false)
  })
})
