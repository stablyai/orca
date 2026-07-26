import { describe, expect, it, vi } from 'vitest'
import {
  CODEX_APP_SERVER_GRANT_JSON_MAX_STRUCTURAL_TOKENS,
  findLastNonEmptyCodexAppServerGrantLine,
  parseCodexAppServerGrantJson
} from './codex-app-server-grant-json'

describe('Codex app-server grant JSON admission', () => {
  it('preserves the last non-empty output line without splitting all output', () => {
    expect(findLastNonEmptyCodexAppServerGrantLine('diagnostic\n\n{"ok":true}\n \t\r')).toBe(
      '{"ok":true}'
    )
    expect(findLastNonEmptyCodexAppServerGrantLine('\n \t\r')).toBeNull()
  })

  it('rejects structurally amplified grant JSON before parsing', () => {
    const text = `{"values":[${'0,'.repeat(CODEX_APP_SERVER_GRANT_JSON_MAX_STRUCTURAL_TOKENS)}0]}`
    const parseSpy = vi.spyOn(JSON, 'parse')
    try {
      expect(() => parseCodexAppServerGrantJson(text)).toThrow(/JSON structure exceeds/)
      expect(parseSpy).not.toHaveBeenCalled()
    } finally {
      parseSpy.mockRestore()
    }
  })
})
