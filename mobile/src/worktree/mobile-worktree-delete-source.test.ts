import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../app/h/[hostId]/index.tsx', import.meta.url), 'utf8')

function sliceBetween(startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('mobile worktree deletion', () => {
  it('opts into archive hooks so the orca.yaml teardown script runs on delete', () => {
    const handleDelete = sliceBetween(
      'const handleDeleteWorktree = useCallback(',
      'const handleRemoveHost = useCallback'
    )

    // Runtime RPC skips the archive hook unless runHooks is set (parity with web).
    // Bind the flag to the worktree.rm payload so it can't pass on an unrelated match.
    expect(handleDelete).toMatch(
      /sendRequest\('worktree\.rm',\s*\{[\s\S]*?runHooks:\s*true[\s\S]*?\}\)/
    )
  })
})
