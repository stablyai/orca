import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDraftPasteReadyScanner } from '../../shared/draft-paste-ready-scanner'

function readiness(name: string, promptText = 'Orca loopback transport'): boolean {
  const transcript = readFileSync(join(__dirname, '__fixtures__', name), 'utf8')
  const promptAt = transcript.indexOf(promptText)
  const bytes = promptAt === -1 ? transcript : transcript.slice(0, promptAt)
  const scanner = createDraftPasteReadyScanner('render-cursor-after-bracketed-paste')
  let ready = false
  for (let offset = 0; offset < bytes.length; offset += 31) {
    ready ||= scanner.observe(bytes.slice(offset, offset + 31)).ready
  }
  return ready
}

describe('Reasonix 1.39.7 actual released PTY', () => {
  it('does not paste into the missing-key connection menu', () => {
    expect(readiness('reasonix-1-39-7-connection.txt')).toBe(false)
  })
  it('recognizes the configured composer before prompt submission', () => {
    expect(readiness('reasonix-1-39-7-loopback.txt')).toBe(true)
  })
  it('keeps the newly captured private first-setup menu unready before any input', () => {
    expect(readiness('reasonix-1-39-7-task-first-setup.txt')).toBe(false)
  })
  it('recognizes the fresh private configured composer before the native failed turn', () => {
    expect(
      readiness('reasonix-1-39-7-task-composer.txt', 'Record this harmless loopback prompt')
    ).toBe(true)
  })
})
