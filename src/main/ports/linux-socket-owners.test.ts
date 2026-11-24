import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { parseSocketHolderListing, pickLastHolders, SOCKET_HOLDER_AWK } from './linux-socket-owners'

describe('Linux socket holder listing', () => {
  it('reads the listing script output and keeps the holder a /proc walk would visit last', () => {
    // `ls -ln /proc/[0-9]*/fd` sorts directories as text; the walk visits them in /proc's own order.
    const ls = [
      '/proc/1000/fd:',
      'total 0',
      'lrwx------ 1 1000 1000 64 Nov 23 17:00 3 -> socket:[4242]',
      'lr-x------ 1 1000 1000 64 Nov 23 17:00 4 -> /dev/null',
      '',
      '/proc/900/fd:',
      'total 0',
      'lrwx------ 1 1000 1000 64 Nov 23 17:00 3 -> socket:[4242]',
      'lrwx------ 1 1000 1000 64 Nov 23 17:00 5 -> socket:[5151]',
      ''
    ].join('\n')
    const output = execFileSync('/bin/sh', ['-c', SOCKET_HOLDER_AWK], { input: ls }).toString()
    const holders = parseSocketHolderListing(output)
    expect(holders).toEqual([
      { pid: 1000, inode: 4242 },
      { pid: 900, inode: 4242 },
      { pid: 900, inode: 5151 }
    ])

    const inodes = new Set([4242, 5151])
    expect(pickLastHolders(holders, ['900', '1000'], inodes)).toEqual(
      new Map([
        [4242, 1000],
        [5151, 900]
      ])
    )
    expect(pickLastHolders(holders, ['1000', '900'], inodes).get(4242)).toBe(900)
  })
})
