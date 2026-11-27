import { describe, expect, it } from 'vitest'
import { LinuxSocketHolderFilter } from './linux-socket-holder-listing'
import { parseSocketHolderListing, pickLastHolders } from './linux-socket-owners'

// `ls -ln /proc/[0-9]*/fd` (LC_ALL=C) sorts directories as text; the walk visits them in /proc's own order.
const LS = [
  '/proc/1000/fd:',
  'total 0',
  'lrwx------ 1 1000 1000 64 Nov 23 17:00 3 -> socket:[4242]',
  'lr-x------ 1 1000 1000 64 Nov 23 17:00 4 -> /dev/null',
  'lrwx------ 1 1000 1000 64 Nov 23  2025 7 -> socket:[777]',
  'lr-x------ 1 1000 1000 64 Nov 23 17:00 8 -> /tmp/report -> socket:[5151]',
  'lr-x------ 1 1000 1000 64 Nov 23 17:00 9 -> /tmp/x socket:[5151]',
  '',
  '/proc/900/fd:',
  'total 0',
  'lrwx------ 1 1000 1000 64 Nov 23 17:00 3 -> socket:[4242]',
  'lrwx------ 1 1000 1000 64 Nov 23 17:00 5 -> socket:[5151]',
  ''
].join('\n')

function listing(wanted: number[], text: string, chunk = 7): string {
  const filter = new LinuxSocketHolderFilter(new Set(wanted))
  for (let i = 0; i < text.length; i += chunk) {
    filter.write(text.slice(i, i + chunk))
  }
  return filter.finish()
}

describe('Linux socket holder listing', () => {
  it('keeps only wanted holders from well-formed rows and the last holder in /proc order', () => {
    const parsed = parseSocketHolderListing(listing([4242, 5151], LS))
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
    // A process forked after /proc was listed is invisible to the walk, so it can't take the socket.
    expect(pickLastHolders(parsed!.holders, ['900'], inodes).get(4242)).toBe(900)
  })

  it('drops only an over-long line, whatever the chunk boundaries', () => {
    const long = `lr-x------ 1 1000 1000 64 Nov 23 17:00 6 -> /${'p'.repeat(4091)}`
    const text = [
      '/proc/100/fd:',
      long,
      'lrwx------ 1 1000 1000 64 Nov 23 17:00 7 -> socket:[4242]',
      ''
    ].join('\n')
    for (const chunk of [7, 4130, 65536]) {
      expect(parseSocketHolderListing(listing([4242], text, chunk))).toEqual({
        holders: [{ pid: 100, inode: 4242 }],
        seen: 1
      })
    }
  })

  it('tells an unreadable layout apart from no wanted holders', () => {
    expect(parseSocketHolderListing(listing([1], LS))).toEqual({ holders: [], seen: 4 })
    expect(
      parseSocketHolderListing(listing([4242], "'/proc/1/fd':\n3 -> socket:[4242]\n"))?.seen
    ).toBe(0)
    expect(parseSocketHolderListing('900 socket:[4242]\n')).toBeNull()
  })
})
