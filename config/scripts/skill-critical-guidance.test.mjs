import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

function readGuide(name) {
  return readFileSync(
    resolve(import.meta.dirname, '../../skill-guides', `${name}.md`),
    'utf8'
  ).replace(/\s+/gu, ' ')
}

it('preserves Linear completion and terminal-state exclusions', () => {
  for (const name of ['orca-linear', 'linear-tickets']) {
    const text = readGuide(name)
    expect(text).toContain('Post exactly one completion comment')
    expect(text).toContain('containing the PR/MR link')
    expect(text).toContain(
      'Completion moves are allowed unless the current type is `completed` or `canceled`'
    )
    expect(text).toContain('If zero or multiple states qualify, leave status unchanged')
  }
})

it('preserves verification distinctions and emulator cleanup', () => {
  const text = readGuide('computer-use')
  expect(text).toContain('`verified` means the changed value was read back')
  expect(text).toContain('unverified (accessibility action unasserted)')
  expect(text).toContain('unverified (synthetic input)')
  expect(text).toContain('Missing verification metadata is unverified')
  for (const name of ['orca-emulator', 'orca-emulator-android']) {
    expect(readGuide(name)).toContain('Run `kill` when you are done')
  }
})

it('preserves paid approvals and provision retry authority', () => {
  const text = readGuide('orca-per-workspace-env')
  expect(text).toContain(
    'Get an explicit OK before each paid step: the base snapshot, the auth snapshot, and `--provision`'
  )
  expect(text).toContain('One OK covers the whole `--provision` fix-and-rerun loop')
})
