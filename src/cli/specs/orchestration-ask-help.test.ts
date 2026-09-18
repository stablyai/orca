import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_COMMAND_SPECS } from './orchestration'
import { formatCommandHelp } from '../help'

function askHelp(): string {
  const found = ORCHESTRATION_COMMAND_SPECS.find(
    (entry) => entry.path.join(' ') === 'orchestration ask'
  )
  if (!found) {
    throw new Error('Missing orchestration ask command spec')
  }
  return formatCommandHelp(found)
}

describe('orchestration ask help contract (#13184)', () => {
  it('documents outcome/pending, exit codes, and resume semantics for engines', () => {
    const help = askHelp()
    expect(help).toContain('outcome')
    expect(help).toContain('timed_out_pending')
    expect(help).toContain('pending=true')
    expect(help).toContain('--resume')
    expect(help).toContain('Exit codes')
    expect(help).toContain('never creates a second question')
  })
})
