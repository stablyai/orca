import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sessionRouteSource = readFileSync(
  new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
  'utf8'
)
// Why: the terminal TextInput branches this guards live in this extracted
// component, not the session route.
const inputBarSource = readFileSync(
  new URL('../session/terminal-session-input-bar.tsx', import.meta.url),
  'utf8'
)
const combinedSource = sessionRouteSource + inputBarSource

describe('terminal iOS IME keyboard', () => {
  it('does not force terminal inputs onto the ASCII-only iOS keyboard', () => {
    expect(combinedSource).not.toContain("'ascii-capable'")
    expect(combinedSource).not.toContain('"ascii-capable"')
  })

  it('does not put terminal keyboard capture behind iOS textContentType semantics', () => {
    expect(combinedSource).not.toContain('textContentType="none"')
    expect(combinedSource).toContain('autoComplete="off"')
  })
})
