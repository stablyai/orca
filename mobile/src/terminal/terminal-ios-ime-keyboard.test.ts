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
})
