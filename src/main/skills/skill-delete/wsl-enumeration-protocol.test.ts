import { describe, expect, it } from 'vitest'
import {
  parseWslInspectPathsOutput,
  parseWslListEntriesOutput,
  WslEnumerationProtocolError
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
    // Unreadable X must refuse like native EACCES; empty output would falsely authorize parent removal.
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
