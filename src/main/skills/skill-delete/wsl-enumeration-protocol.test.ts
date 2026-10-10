import { describe, expect, it } from 'vitest'
import {
  parseWslInspectPathsOutput,
  parseWslListEntriesOutput,
  WslEnumerationProtocolError,
  WSL_INSPECT_PATHS_SCRIPT,
  WSL_LIST_ENTRIES_SCRIPT
} from './wsl-enumeration-protocol'

const NUL = '\0'

function records(...fields: string[]): string {
  return fields.map((field) => `${field}${NUL}`).join('')
}

describe('parseWslListEntriesOutput', () => {
  it('keys listings by the caller’s own strings, not the guest spelling', () => {
    const directories = [
      '\\\\wsl.localhost\\Ubuntu\\home\\u\\.agents\\skills',
      '\\\\wsl.localhost\\Ubuntu\\home\\u\\.claude\\skills'
    ]
    const output = records('D', '0', 'E', 'demo', 'directory', 'E', 'link', 'symlink', 'D', '1')
    const listings = parseWslListEntriesOutput(output, directories)
    expect(listings.get(directories[0])).toEqual([
      { name: 'demo', kind: 'directory' },
      { name: 'link', kind: 'symlink' }
    ])
    expect(listings.get(directories[1])).toEqual([])
  })

  it('reports an absent directory as an empty listing rather than a missing key', () => {
    const listings = parseWslListEntriesOutput('', ['/a', '/b'])
    expect([...listings.keys()]).toEqual(['/a', '/b'])
    expect(listings.get('/a')).toEqual([])
  })

  it('refuses an unknown record kind instead of guessing', () => {
    expect(() => parseWslListEntriesOutput(records('X', '0'), ['/a'])).toThrow(
      WslEnumerationProtocolError
    )
  })

  it('refuses an index no argument produced', () => {
    expect(() => parseWslListEntriesOutput(records('D', '7'), ['/a'])).toThrow(
      WslEnumerationProtocolError
    )
  })

  it('refuses an unreadable directory rather than reporting it empty', () => {
    // An empty listing tells the planner "nothing left here"; the guest marks
    // an unreadable directory with `X` so it fails like native EACCES instead.
    expect(() => parseWslListEntriesOutput(records('D', '0', 'X'), ['/a'])).toThrow(
      WslEnumerationProtocolError
    )
  })
})

describe('parseWslInspectPathsOutput', () => {
  it('scales the guest’s whole-second mtime the way WSL discovery does', () => {
    const output = records('P', '0', 'file', '/home/u/.agents/skills/demo/SKILL.md', '1700000000')
    const inspections = parseWslInspectPathsOutput(output, ['/host/path'])
    expect(inspections.get('/host/path')).toEqual({
      kind: 'file',
      realpath: '/home/u/.agents/skills/demo/SKILL.md',
      mtimeMs: 1_700_000_000_000
    })
  })

  it('reports an unresolvable realpath and an unreadable mtime as null', () => {
    const inspections = parseWslInspectPathsOutput(records('P', '0', 'symlink', '', ''), ['/p'])
    expect(inspections.get('/p')).toEqual({ kind: 'symlink', realpath: null, mtimeMs: null })
  })

  it('refuses an unknown entry kind', () => {
    expect(() =>
      parseWslInspectPathsOutput(records('P', '0', 'socket', '/x', '1'), ['/p'])
    ).toThrow(WslEnumerationProtocolError)
  })
})

describe('guest scripts', () => {
  it('classify a symlink before following it, so a broken link is not "missing"', () => {
    expect(WSL_INSPECT_PATHS_SCRIPT.indexOf('-L "$path"')).toBeLessThan(
      WSL_INSPECT_PATHS_SCRIPT.indexOf('-d "$path"')
    )
    expect(WSL_LIST_ENTRIES_SCRIPT.indexOf('-L "$entry"')).toBeLessThan(
      WSL_LIST_ENTRIES_SCRIPT.indexOf('-d "$entry"')
    )
  })

  it('reads mtime without dereferencing, matching WSL discovery', () => {
    expect(WSL_INSPECT_PATHS_SCRIPT).toContain(`stat -c '%Y' -- "$path"`)
    expect(WSL_INSPECT_PATHS_SCRIPT).not.toContain('stat -L')
  })

  it('takes every path positionally rather than interpolating it into the script', () => {
    expect(WSL_LIST_ENTRIES_SCRIPT).toContain('for dir in "$@"; do')
    expect(WSL_INSPECT_PATHS_SCRIPT).toContain('for path in "$@"; do')
  })

  it('marks an unreadable directory instead of listing it as empty', () => {
    expect(WSL_LIST_ENTRIES_SCRIPT).toContain('if ! [ -r "$dir" ]; then')
    expect(WSL_LIST_ENTRIES_SCRIPT).toContain(`printf 'X\\0'`)
  })
})
