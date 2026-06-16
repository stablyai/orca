import { describe, expect, it } from 'vitest'

import {
  REPEATED_FLAG_SEPARATOR,
  parseArgs,
  supportsBrowserPageFlag,
  validateCommandAndFlags
} from './args'

describe('parseArgs', () => {
  it('keeps an empty string as a flag value', () => {
    const parsed = parseArgs(['computer', 'set-value', '--value', '', '--json'])

    expect(parsed.commandPath).toEqual(['computer', 'set-value'])
    expect(parsed.flags.get('value')).toBe('')
    expect(parsed.flags.get('json')).toBe(true)
  })

  it('accepts a flag value that starts with -- via the = form', () => {
    const parsed = parseArgs(['terminal', 'send', '--text=--help'])

    expect(parsed.commandPath).toEqual(['terminal', 'send'])
    expect(parsed.flags.get('text')).toBe('--help')
  })

  it('splits --flag=value on the first = so values may contain =', () => {
    const parsed = parseArgs(['set', 'cookie', '--value=a=b=c'])

    expect(parsed.flags.get('value')).toBe('a=b=c')
  })

  it('treats --flag= as an empty string value', () => {
    const parsed = parseArgs(['--value='])

    expect(parsed.flags.get('value')).toBe('')
  })

  it('still parses boolean flags and space-separated values', () => {
    const parsed = parseArgs(['tab', 'create', '--json', '--url', 'https://example.com'])

    expect(parsed.commandPath).toEqual(['tab', 'create'])
    expect(parsed.flags.get('json')).toBe(true)
    expect(parsed.flags.get('url')).toBe('https://example.com')
  })

  it('preserves repeated string flags', () => {
    const parsed = parseArgs(['linear', 'label', 'add', '--label', 'Bug', '--label=Regression'])

    expect(parsed.flags.get('label')).toBe(`Bug${REPEATED_FLAG_SEPARATOR}Regression`)
  })

  it('does not apply repeated flag encoding to ordinary string flags', () => {
    const parsed = parseArgs(['linear', 'list', '--workspace', 'old', '--workspace', 'new'])

    expect(parsed.flags.get('workspace')).toBe('new')
  })
})

describe('supportsBrowserPageFlag', () => {
  it('does not expose browser page targeting on orchestration commands', () => {
    expect(supportsBrowserPageFlag(['orchestration', 'send'])).toBe(false)
  })
})

describe('validateCommandAndFlags', () => {
  const specs = [
    {
      path: ['demo'],
      summary: 'Demo command',
      usage: 'orca demo',
      allowedFlags: []
    }
  ]

  it('allows global runtime selector flags even when the command spec omits them', () => {
    const parsed = parseArgs([
      'demo',
      '--pairing-code',
      'remote-runtime',
      '--environment',
      'server',
      '--json'
    ])

    expect(() => validateCommandAndFlags(specs, parsed)).not.toThrow()
  })

  it('still rejects unknown command-specific flags', () => {
    const parsed = parseArgs(['demo', '--bogus'])

    expect(() => validateCommandAndFlags(specs, parsed)).toThrow(
      'Unknown flag --bogus for command: demo'
    )
  })
})
