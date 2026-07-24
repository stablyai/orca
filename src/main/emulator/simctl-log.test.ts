import { describe, expect, it } from 'vitest'
import {
  buildSimulatorLogPredicate,
  parseSimulatorLogLine,
  simctlLogShowArgs,
  type SimulatorLogEntry
} from './simctl-log'

describe('simctlLogShowArgs', () => {
  it('builds a bounded one-shot unified log command', () => {
    expect(simctlLogShowArgs('device-1')).toEqual([
      'simctl',
      'spawn',
      'device-1',
      'log',
      'show',
      '--style',
      'ndjson',
      '--last',
      '1m'
    ])
  })

  it('adds a custom window and filter predicate', () => {
    expect(simctlLogShowArgs('device-1', { window: '2m', filters: ['com.acme'] })).toEqual([
      'simctl',
      'spawn',
      'device-1',
      'log',
      'show',
      '--style',
      'ndjson',
      '--last',
      '2m',
      '--predicate',
      '(subsystem CONTAINS[c] "com.acme" OR category CONTAINS[c] "com.acme" OR process CONTAINS[c] "com.acme" OR eventMessage CONTAINS[c] "com.acme")'
    ])
  })
})

describe('buildSimulatorLogPredicate', () => {
  it('ignores empty filters and combines escaped values', () => {
    expect(buildSimulatorLogPredicate()).toBeUndefined()
    expect(buildSimulatorLogPredicate(['', '   '])).toBeUndefined()
    expect(buildSimulatorLogPredicate(['App "UI"', String.raw`path\name`])).toBe(
      '(subsystem CONTAINS[c] "App \\"UI\\"" OR category CONTAINS[c] "App \\"UI\\"" OR process CONTAINS[c] "App \\"UI\\"" OR eventMessage CONTAINS[c] "App \\"UI\\"") OR ' +
        '(subsystem CONTAINS[c] "path\\\\name" OR category CONTAINS[c] "path\\\\name" OR process CONTAINS[c] "path\\\\name" OR eventMessage CONTAINS[c] "path\\\\name")'
    )
  })
})

describe('parseSimulatorLogLine', () => {
  it('normalizes unified log fields and skips empty tags', () => {
    const line = JSON.stringify({
      timestamp: '2026-07-24 15:13:56.722036+0900',
      messageType: 'Default',
      subsystem: '',
      category: 'network',
      processImagePath: '/Applications/Demo.app/Demo',
      eventMessage: 'connected'
    })
    expect(parseSimulatorLogLine(line)).toEqual<SimulatorLogEntry>({
      timestamp: '2026-07-24 15:13:56.722036+0900',
      level: 'Default',
      tag: 'network',
      message: 'connected'
    })
  })

  it('falls back to the process image basename', () => {
    expect(
      parseSimulatorLogLine(
        '{"subsystem":"","category":"","processImagePath":"/Applications/Demo.app/Demo","eventMessage":"ready"}'
      )
    ).toEqual<SimulatorLogEntry>({ tag: 'Demo', message: 'ready' })
  })

  it('ignores structural and malformed lines', () => {
    expect(parseSimulatorLogLine('')).toBeUndefined()
    expect(parseSimulatorLogLine('[')).toBeUndefined()
    expect(parseSimulatorLogLine('],')).toBeUndefined()
    expect(parseSimulatorLogLine('null')).toBeUndefined()
    expect(parseSimulatorLogLine('{"traceID":42}')).toBeUndefined()
    expect(parseSimulatorLogLine('{"eventMessage":""}')).toBeUndefined()
    expect(parseSimulatorLogLine('{broken')).toBeUndefined()
  })
})
