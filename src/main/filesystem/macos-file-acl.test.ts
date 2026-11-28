import { describe, expect, it } from 'vitest'
import { parseFilesWithAcl } from './macos-file-acl'

const A = '/Users/me/Library/Application Support/orca/home/sessions.orca-profile-merge/a.jsonl'
const B = '/Users/me/Library/Application Support/orca/home/sessions.orca-profile-merge/b.jsonl'

describe('parseFilesWithAcl', () => {
  it('reads ACL entries under each file, even when @ hides the +', () => {
    const listing = [
      `-rw-r--r--@ 1 me  staff  10 Nov 26 11:10 ${A}`,
      ' 0: user:other allow write,append',
      `-rw-r--r--  1 me  staff  10 Nov 26 11:10 ${B}`,
      ''
    ].join('\n')
    expect(parseFilesWithAcl(listing, [A, B])).toEqual(new Set([A]))
  })

  it('cannot tell when a file has no line of its own', () => {
    expect(parseFilesWithAcl(`-rw-r--r--  1 me  staff  10 Nov 26 11:10 ${B}\n`, [A, B])).toBeNull()
    expect(parseFilesWithAcl(` 0: user:other allow write\n`, [A])).toBeNull()
  })
})
