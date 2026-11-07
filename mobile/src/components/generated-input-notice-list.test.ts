import { expect, it } from 'vitest'
import { GeneratedInputNoticeList } from './generated-input-notice-list'

const notice = (id: string) =>
  ({
    id,
    text: id,
    agent: 'claude',
    certainty: 'not-sent',
    handle: 'h',
    worktreeId: 'w',
    ptyId: null
  }) as const

it('keeps newest-first live ranks across append, deletion, compaction and metadata replacement', () => {
  const list = new GeneratedInputNoticeList()
  for (let index = 0; index < 100; index += 1) {
    list.add(notice(`${index}`), 's')
  }
  for (let index = 0; index < 99; index += 1) {
    list.dismiss(`${index}`)
  }
  list.add({ ...notice('draft'), submitted: false }, 's')
  expect([list.at(0)?.notice.id, list.at(1)?.notice.id, list.at(2)]).toEqual([
    'draft',
    '99',
    undefined
  ])
  expect(list.promptCount).toBe(1)
  const kept = list.at(1)
  list.replace(
    [
      { ...notice('99'), certainty: 'unconfirmed' },
      { ...notice('draft'), submitted: false }
    ],
    's'
  )
  expect(list.at(1)).not.toBe(kept)
  expect(list.at(1)?.notice.certainty).toBe('unconfirmed')
  list.dismiss('draft')
  expect(list.at(0)?.notice.id).toBe('99')
})

it('does logarithmic delta and visible-rank work at N and 10N', () => {
  for (const count of [1_000, 10_000]) {
    const list = new GeneratedInputNoticeList()
    list.replace(
      Array.from({ length: count }, (_, index) => notice(`${index}`)),
      's'
    )
    list.visits = 0
    list.add(notice('new'), 's')
    list.dismiss(`${count - 2}`)
    expect(Array.from({ length: 6 }, (_, index) => list.at(index)?.notice.id)).toEqual([
      'new',
      `${count - 1}`,
      `${count - 3}`,
      `${count - 4}`,
      `${count - 5}`,
      `${count - 6}`
    ])
    // Two append prefix reads, one removal update and six requested live ranks: each uses one
    // logarithmic tree walk, with slack for the newly grown aggregate node, never hidden rows.
    expect(list.visits).toBeLessThanOrEqual(12 * (Math.ceil(Math.log2(count + 2)) + 1))
  }
})
