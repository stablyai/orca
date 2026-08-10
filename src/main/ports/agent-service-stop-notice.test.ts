import { describe, expect, it } from 'vitest'
import { buildAgentStopNotice, toTerminalInput } from './agent-service-stop-notice'

describe('buildAgentStopNotice', () => {
  it('states the stop was deliberate so the agent does not treat it as a crash', () => {
    const notice = buildAgentStopNotice({
      serviceName: 'web',
      port: 3060,
      projectName: 'skimatch'
    })

    expect(notice).toContain('web (:3060)')
    expect(notice).toContain('skimatch')
    expect(notice).toContain('deliberate')
    expect(notice).toContain('Do not restart it unless I ask')
  })

  it('falls back to the port when the service has no resolved name', () => {
    const notice = buildAgentStopNotice({ serviceName: null, port: 8080, projectName: null })

    expect(notice).toContain('port 8080')
    expect(notice).not.toContain('null')
  })

  it('omits the project clause rather than printing an empty one', () => {
    const notice = buildAgentStopNotice({ serviceName: 'api', port: 4000, projectName: null })

    expect(notice).not.toContain(' in ')
  })
})

describe('toTerminalInput', () => {
  it('submits with a carriage return', () => {
    expect(toTerminalInput('hello')).toBe('hello\r')
  })

  it('collapses newlines so a message cannot submit halfway through', () => {
    const input = toTerminalInput('first line\nsecond line')

    expect(input).toBe('first line second line\r')
    expect(input.indexOf('\r')).toBe(input.length - 1)
  })

  it('collapses carriage returns embedded in the notice', () => {
    expect(toTerminalInput('a\r\nb')).toBe('a b\r')
  })

  it('strips escape sequences so a crafted name cannot reach the agent terminal', () => {
    // A container image or project name is not fully trusted; an embedded ESC
    // would otherwise be interpreted by the terminal instead of shown as text.
    const input = toTerminalInput('stopped \u001b[31mred\u001b[0m service')

    expect(input).not.toContain('\u001b')
    // Control bytes collapse to a space rather than being deleted, so the
    // surrounding words cannot be silently fused into one token.
    expect(input).toBe('stopped [31mred [0m service\r')
  })

  it('strips every other C0 control byte', () => {
    expect(toTerminalInput('a\u0007b\u0000c')).toBe('a b c\r')
  })

  it('still ends with exactly one carriage return', () => {
    const input = toTerminalInput('\u001b\u001b weird \r\n name \u0007')

    expect(input.endsWith('\r')).toBe(true)
    expect(input.split('\r')).toHaveLength(2)
  })
})
