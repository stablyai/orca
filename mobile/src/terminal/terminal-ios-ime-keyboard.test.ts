import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sessionRouteSource = readFileSync(
  new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
  'utf8'
)

describe('terminal iOS IME keyboard', () => {
  it('does not force terminal inputs onto the ASCII-only iOS keyboard', () => {
    expect(sessionRouteSource).not.toContain("'ascii-capable'")
    expect(sessionRouteSource).not.toContain('"ascii-capable"')
  })

  it('subscribes live capture to onChange so the marked-text report survives', () => {
    // onChangeText hands over only a string, discarding the preedit report that
    // decides whether the text may reach the PTY at all.
    expect(sessionRouteSource).toContain('onChange={handleLiveInputChange}')
    expect(sessionRouteSource).not.toContain('onChangeText={handleLiveInputChange}')
  })

  it('does not put terminal keyboard capture behind iOS textContentType semantics', () => {
    expect(sessionRouteSource).not.toContain('textContentType="none"')
    expect(sessionRouteSource).toContain('autoComplete="off"')
  })
})
