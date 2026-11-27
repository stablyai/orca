import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { createDraftPasteReadyScanner } from '../../../../shared/agent-launch/startup/readiness/draft-paste-ready-scanner'

it('waits through the sending-paused composer before delivering the first dispatch', () => {
  const boot = readFileSync(
    new URL('../../__fixtures__/doubao-composer-ready.txt', import.meta.url),
    'utf8'
  )
  const footer = 'Default model · max · C:\\workspace'
  const footerStart = boot.indexOf(footer)
  expect(footerStart).toBeGreaterThan(boot.indexOf('You can type; sending is paused'))
  const scanner = createDraftPasteReadyScanner('doubao-composer-ready')
  for (const chunk of boot.slice(0, footerStart)) {
    expect(scanner.observe(chunk).ready).toBe(false)
  }
  expect([...footer].some((chunk) => scanner.observe(chunk).ready)).toBe(true)
})

it('reads a styled Orca footer across PTY chunks', () => {
  const scanner = createDraftPasteReadyScanner('doubao-composer-ready')
  const paint = '\x1b[2mAsk Doubao to do anything\x1b[22m'
  expect(scanner.observe(paint).ready).toBe(false)
  const footer = '\x1b[39m\x1b[2m · \x1b[22mMaximum\x1b[2m · \x1b[22mD:\\workspace'
  expect([...footer].some((chunk) => scanner.observe(chunk).ready)).toBe(true)
})
