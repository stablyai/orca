import { describe, expect, it } from 'vitest'
import { buildAuggieManagedScript, buildAuggieWindowsManagedScript } from './hook-service'
import { wrapPosixHookCommand } from '../agent-hooks/installer-utils'

describe('Auggie hook launcher contract', () => {
  it('uses bounded stdin and the Auggie endpoint for fish/posix launches', () => {
    const source = buildAuggieManagedScript('posix')
    expect(source).toContain('JSONDecoder')
    expect(source).toContain('/hook/aug')
    expect(source).toContain('--data-urlencode "payload@-"')
  })

  it('quotes argv paths containing spaces and shell metacharacters', () => {
    const command = wrapPosixHookCommand("/tmp/Orca Hooks/aug's hook.sh")
    expect(command).toContain("'/tmp/Orca Hooks/aug'\\''s hook.sh'")
    expect(command).toContain('/bin/sh')
    expect(command).not.toContain('bash -c')
  })

  it('ships a Windows command wrapper with the same guarded curl contract', () => {
    const source = buildAuggieWindowsManagedScript()
    expect(source).toContain('@echo off')
    expect(source).toContain('/hook/aug')
    expect(source).toContain('ORCA_AGENT_HOOK_TOKEN')
  })
})
