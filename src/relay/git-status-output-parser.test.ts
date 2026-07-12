import { describe, expect, it } from 'vitest'
import { parseStatusOutput } from './git-status-output-parser'

describe('parseStatusOutput', () => {
  it('marks staged S... submodule rows as commit-changed gitlinks', () => {
    const parsed = parseStatusOutput(
      '1 M. S... 160000 160000 160000 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb flutter_mine\n'
    )

    expect(parsed.entries).toEqual([
      {
        path: 'flutter_mine',
        status: 'modified',
        area: 'staged',
        submodule: { commitChanged: true, trackedChanges: false, untrackedChanges: false }
      }
    ])
  })
})
