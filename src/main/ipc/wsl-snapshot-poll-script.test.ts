import { describe, expect, it } from 'vitest'

import { buildSnapshotScript } from './wsl-snapshot-poll-script'

function scanLine(script: string): string {
  const line = script.split('\n').find((entry) => entry.includes('find "$root"'))
  expect(line).toBeDefined()
  return line as string
}

describe('buildSnapshotScript', () => {
  it('scans the whole worktree so files nested below two levels are seen', () => {
    const line = scanLine(buildSnapshotScript(['node_modules', '.git']))

    expect(line).toContain('-mindepth 1')
    expect(line).not.toContain('-maxdepth')
  })

  it('prunes ignored directories at every depth', () => {
    const line = scanLine(buildSnapshotScript(['node_modules', '.git']))

    expect(line).toContain("\\( -type d \\( -name 'node_modules' -o -name '.git' \\) -prune \\) -o")
  })

  it('backs the poll interval off on large trees instead of capping depth', () => {
    const script = buildSnapshotScript(['node_modules'])

    expect(script).toContain('size=$(wc -c < "$snapshot" 2>/dev/null || echo 0)')
    expect(script).toContain('interval=10')
    expect(script).toContain('sleep "$interval" || exit 0')
  })

  it('fails loudly on distros whose find lacks GNU -printf', () => {
    expect(buildSnapshotScript([])).toContain('orca-watcher-unsupported-find')
  })

  it('rejects ignore names that would break out of the find expression', () => {
    expect(() => buildSnapshotScript(["a' -o -delete '"])).toThrow(
      'Unsupported WSL watcher ignore name'
    )
  })
})
