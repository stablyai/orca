import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { parseSocketHolderListing, pickLastHolders, SOCKET_HOLDER_AWK } from './linux-socket-owners'

// `ls -ln /proc/[0-9]*/fd` sorts directories as text; the walk visits them in /proc's own order.
const LS = [
  '/proc/1000/fd:',
  'total 0',
  'lrwx------ 1 1000 1000 64 Nov 23 17:00 3 -> socket:[4242]',
  'lr-x------ 1 1000 1000 64 Nov 23 17:00 4 -> /dev/null',
  'lrwx------ 1 1000 1000 64 Nov 23 17:00 7 -> socket:[777]',
  'lr-x------ 1 1000 1000 64 Nov 23 17:00 8 -> /tmp/x -> socket:[5151]x',
  '',
  '/proc/900/fd:',
  'total 0',
  'lrwx------ 1 1000 1000 64 Nov 23 17:00 3 -> socket:[4242]',
  'lrwx------ 1 1000 1000 64 Nov 23 17:00 5 -> socket:[5151]',
  ''
].join('\n')
const awk = (want: string, input: string): string =>
  execFileSync('/bin/sh', ['-c', SOCKET_HOLDER_AWK, 'sh', want], { input }).toString()

describe('Linux socket holder listing', () => {
  it('prints only wanted holders, counts every socket, and keeps the last holder in /proc order', () => {
    const parsed = parseSocketHolderListing(awk(',4242,5151,', LS))
    expect(parsed).toEqual({
      holders: [
        { pid: 1000, inode: 4242 },
        { pid: 900, inode: 4242 },
        { pid: 900, inode: 5151 }
      ],
      seen: 4
    })
    const inodes = new Set([4242, 5151])
    expect(pickLastHolders(parsed!.holders, ['900', '1000'], inodes)).toEqual(
      new Map([
        [4242, 1000],
        [5151, 900]
      ])
    )
    expect(pickLastHolders(parsed!.holders, ['1000', '900'], inodes).get(4242)).toBe(900)
  })

  it('tells an unreadable layout apart from no wanted holders', () => {
    expect(parseSocketHolderListing(awk(',1,', LS))).toEqual({ holders: [], seen: 4 })
    expect(
      parseSocketHolderListing(awk(',4242,', "'/proc/1/fd':\n3 -> socket:[4242]\n"))?.seen
    ).toBe(0)
    expect(parseSocketHolderListing('900 socket:[4242]\n')).toBeNull()
  })
})
