import { describe, expect, it } from 'vitest'
import {
  CODEX_EXACT_COMMAND_MAX_BYTES,
  codexExactCommandDisplay,
  decodeStrictShellWrapper
} from './codex-command-exact-display'

describe('codexExactCommandDisplay', () => {
  it('unwraps a whole single-quoted bash, zsh or sh -c/-lc wrapper, apostrophes included', () => {
    expect(
      codexExactCommandDisplay(`/opt/homebrew/bin/bash -lc 'echo '\\''it works'\\'' && ls'`)
    ).toBe(`echo 'it works' && ls`)
    expect(codexExactCommandDisplay(`/bin/zsh -c 'pnpm test'`)).toBe('pnpm test')
    expect(codexExactCommandDisplay(`sh -c 'git status --short'`)).toBe('git status --short')
  })

  it('keeps benign spaces and newlines exactly', () => {
    expect(codexExactCommandDisplay(`/bin/bash -lc 'cat <<EOF\n  two  spaces\nEOF'`)).toBe(
      'cat <<EOF\n  two  spaces\nEOF'
    )
  })

  it('leaves any other wrapper verbatim when the whole text is eligible', () => {
    for (const command of [
      `/bin/bash -lc "echo hi"`,
      `/bin/bash -lc 'echo hi' && true`,
      `/bin/fish -c 'echo hi'`,
      `/bin/bash -x -c 'echo hi'`,
      'git status'
    ]) {
      expect(decodeStrictShellWrapper(command)).toBeNull()
      expect(codexExactCommandDisplay(command)).toBe(command)
    }
  })

  it('refuses anything not proven whole and unredacted', () => {
    expect(codexExactCommandDisplay('   ')).toBeNull()
    expect(codexExactCommandDisplay(`/bin/bash -lc '  '`)).toBeNull()
    expect(codexExactCommandDisplay('echo a\0b')).toBeNull()
    expect(codexExactCommandDisplay('<command included NUL byte>')).toBeNull()
    expect(codexExactCommandDisplay('curl -H [REDACTED_SECRET]')).toBeNull()
    expect(codexExactCommandDisplay(`/bin/bash -lc 'echo [REDACTED_SECRET]'`)).toBeNull()
    // Bytes Orca's own sanitizer would rewrite were never shown verbatim: never store them.
    expect(codexExactCommandDisplay('export API_KEY=abcdefgh12345678')).toBeNull()
    expect(codexExactCommandDisplay(`echo \uD800`)).toBeNull()
    expect(codexExactCommandDisplay('x'.repeat(CODEX_EXACT_COMMAND_MAX_BYTES + 1))).toBeNull()
    expect(codexExactCommandDisplay('é'.repeat(CODEX_EXACT_COMMAND_MAX_BYTES / 2))).not.toBeNull()
    expect(codexExactCommandDisplay(`${'é'.repeat(CODEX_EXACT_COMMAND_MAX_BYTES / 2)}x`)).toBeNull()
  })
})
