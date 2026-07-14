import { describe, expect, it } from 'vitest'
import { codexHomeForSessionsDir } from './session-scanner-codex-paths'

describe('codexHomeForSessionsDir', () => {
  it('keeps the default Codex home explicit for authority-bound resume', () => {
    expect(codexHomeForSessionsDir('/home/ada/.codex/sessions')).toBe('/home/ada/.codex')
  })

  it('keeps a managed Codex home explicit', () => {
    expect(codexHomeForSessionsDir('/orca/runtime/home/sessions')).toBe('/orca/runtime/home')
  })
})
