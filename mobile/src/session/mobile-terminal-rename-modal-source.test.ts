import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
  'utf8'
)

describe('mobile terminal rename modal sequencing', () => {
  it('waits for the terminal action sheet to close before opening rename', () => {
    expect(source).toMatch(
      /label: 'Rename',[\s\S]*?closeBeforePress: true,[\s\S]*?setRenameTarget\(target\)/
    )
  })
})
