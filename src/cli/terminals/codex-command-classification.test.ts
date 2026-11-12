import { describe, expect, it } from 'vitest'

import { shouldUseRendererBackedCodexTerminal } from './codex-command-classification'

describe('shouldUseRendererBackedCodexTerminal', () => {
  it('keeps one-shot Codex commands on the background path', () => {
    expect(shouldUseRendererBackedCodexTerminal('codex exec summarize')).toBe(false)
    expect(shouldUseRendererBackedCodexTerminal('codex -m gpt-5 review')).toBe(false)
    expect(shouldUseRendererBackedCodexTerminal('codex login status')).toBe(false)
    expect(shouldUseRendererBackedCodexTerminal('codex login --with-api-key')).toBe(false)
    expect(shouldUseRendererBackedCodexTerminal('codex cloud list --json')).toBe(false)
    expect(shouldUseRendererBackedCodexTerminal('codex -c active=cloud cloud list --json')).toBe(
      false
    )
    expect(shouldUseRendererBackedCodexTerminal('codex cloud --enable foo list --json')).toBe(false)
    expect(
      shouldUseRendererBackedCodexTerminal(
        'env -u DEBUG CODEX_HOME=/tmp/codex codex exec summarize'
      )
    ).toBe(false)
    expect(shouldUseRendererBackedCodexTerminal('codex cloud exec "fix it"')).toBe(false)
    expect(shouldUseRendererBackedCodexTerminal('codex cloud --version')).toBe(false)
    expect(shouldUseRendererBackedCodexTerminal('codex --help')).toBe(false)
  })

  it('reads --no-daemon as a flag, not the subcommand', () => {
    expect(shouldUseRendererBackedCodexTerminal('codex --no-daemon resume --last')).toBe(true)
    expect(shouldUseRendererBackedCodexTerminal('codex --no-daemon exec summarize')).toBe(false)
  })
})
