import { describe, expect, it } from 'vitest'
import {
  classifyOfficecliRun,
  classifySwitchStatus,
  officecliDetail,
  officecliRunSucceeded,
  parseAlreadyWatchedPort
} from './office-error-codes'
import type { OfficecliRun } from './officecli-invocation'

function run(overrides: Partial<OfficecliRun>): OfficecliRun {
  return { code: 1, stdout: '', stderr: '', timedOut: false, ...overrides }
}

describe('officecli failure classification', () => {
  it('names an unsupported format instead of blaming the toolchain', () => {
    // The failure this whole vocabulary exists to prevent: telling a reader to install a tool
    // that ran fine and simply does not render their file.
    const refusal = run({
      stdout:
        '{"success":false,"error":{"error":"Unsupported file type: .doc.","code":"unsupported_type"}}'
    })
    expect(classifyOfficecliRun(refusal, 'render').code).toBe('OFFICECLI_UNSUPPORTED_FORMAT')
  })

  it('recognises a missing file', () => {
    expect(classifyOfficecliRun(run({ stderr: 'file not found: /w/a.docx' }), 'render').code).toBe(
      'OFFICECLI_FILE_NOT_FOUND'
    )
  })

  it('recognises an already-watched document and recovers its port', () => {
    const refusal = run({
      stderr:
        'Error: Another watch process is already running at http://localhost:26399 for /w/a.pptx'
    })
    expect(classifyOfficecliRun(refusal, 'watch').code).toBe('OFFICECLI_ALREADY_WATCHED')
    expect(parseAlreadyWatchedPort(refusal.stderr)).toBe(26399)
  })

  it('refuses an out-of-range port from the already-watched message', () => {
    expect(parseAlreadyWatchedPort('already running at http://localhost:99999 for /w/a.pptx')).toBe(
      null
    )
    expect(parseAlreadyWatchedPort('no url here')).toBe(null)
  })

  it('reports a watch timeout distinctly from a render failure', () => {
    expect(classifyOfficecliRun(run({ timedOut: true }), 'watch').code).toBe(
      'OFFICECLI_PORT_TIMEOUT'
    )
    expect(classifyOfficecliRun(run({ timedOut: true }), 'render').code).toBe(
      'OFFICECLI_RENDER_FAILED'
    )
  })

  it('recognises a stop against a document nothing is watching', () => {
    expect(classifyOfficecliRun(run({ stdout: 'No watch running for a.pptx' }), 'watch').code).toBe(
      'OFFICE_WATCH_NOT_RUNNING'
    )
  })

  it('treats a JSON success:false as a failure even on exit 0', () => {
    expect(officecliRunSucceeded(run({ code: 0, stdout: '{"success":false}' }))).toBe(false)
    expect(officecliRunSucceeded(run({ code: 0, stdout: '{"success":true}' }))).toBe(true)
  })

  it('collapses diagnostics to one bounded line', () => {
    const detail = officecliDetail(run({ stdout: '{"error":"line one\\nline two"}' }))
    expect(detail).toBe('line one line two')
    expect(officecliDetail(run({}))).toBeUndefined()
    expect(officecliDetail(run({ stderr: 'x'.repeat(900) }))?.length).toBe(400)
  })

  it('maps every documented /api/switch rejection', () => {
    expect(classifySwitchStatus(404).code).toBe('OFFICECLI_FILE_NOT_FOUND')
    expect(classifySwitchStatus(409).code).toBe('OFFICECLI_ALREADY_WATCHED')
    expect(classifySwitchStatus(400).code).toBe('OFFICECLI_UNSUPPORTED_FORMAT')
    expect(classifySwitchStatus(500).code).toBe('OFFICECLI_WATCH_FAILED')
  })
})
