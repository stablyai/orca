import { expect, it } from 'vitest'
import { retainUnchangedGraphRecord } from './runtime-graph-record-republication'

it('retains only unchanged records, including their output-buffer references', () => {
  const before = { ptyId: 'source', generation: 1, tail: ['output'] }
  expect(retainUnchangedGraphRecord(before, { ...before })).toBe(before)
  for (const after of [
    { ...before, generation: 2 },
    { ...before, ptyId: 'replacement' },
    { ...before, tail: [...before.tail] }
  ]) {
    expect(retainUnchangedGraphRecord(before, after)).toBe(after)
  }
})

it('distinguishes absent keys, explicit undefined, and newly introduced records', () => {
  const before = { ptyId: 'source' }
  const after = { ...before, extra: undefined }
  expect(retainUnchangedGraphRecord(before, after)).toBe(after)
  expect(retainUnchangedGraphRecord(after, before)).toBe(before)
  expect(retainUnchangedGraphRecord(undefined, before)).toBe(before)
})
