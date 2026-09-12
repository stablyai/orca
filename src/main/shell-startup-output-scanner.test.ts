import { describe, expect, it } from 'vitest'
import {
  createShellStartupOutputScanState,
  drainShellStartupOutputScanState,
  scanShellStartupOutput
} from './shell-startup-output-scanner'

const READY_MARKER = '\x1b]777;orca-shell-ready\x07'
const IDENTITY_MARKER = '\x1b]777;orca-shell-start:12345\x07'

function scanChunks(chunks: string[]): {
  output: string
  shellPid: number | null
  ready: boolean
  postMarkerBytesObserved: boolean
} {
  const state = createShellStartupOutputScanState()
  let output = ''
  let shellPid: number | null = null
  let ready = false
  let postMarkerBytesObserved = false

  for (const chunk of chunks) {
    const scanned = scanShellStartupOutput(state, chunk)
    output += scanned.output
    shellPid ??= scanned.shellPid
    ready ||= scanned.ready
    postMarkerBytesObserved ||= scanned.postMarkerBytesObserved
  }
  return { output, shellPid, ready, postMarkerBytesObserved }
}

function expectEverySplitToProduce(
  input: string,
  expected: Omit<ReturnType<typeof scanChunks>, 'postMarkerBytesObserved'>
): void {
  for (let split = 0; split <= input.length; split += 1) {
    const { postMarkerBytesObserved: _, ...scanned } = scanChunks([
      input.slice(0, split),
      input.slice(split)
    ])
    expect(scanned, `split ${split}`).toEqual(expected)
  }
}

describe('shell startup output scanner', () => {
  it.each([
    ['after the ready marker', [READY_MARKER, '\x1b[?2004hfish> ']],
    ['after the ESC introducer', [`${READY_MARKER}\x1b`, '[?2004hfish> ']]
  ])('preserves Fish output split %s', (_boundary, chunks) => {
    const state = createShellStartupOutputScanState()
    let output = ''

    for (const chunk of chunks) {
      output += scanShellStartupOutput(state, chunk).output
    }

    expect(output).toBe('\x1b[?2004hfish> ')
  })

  it('preserves every post-ready byte at every chunk boundary', () => {
    expectEverySplitToProduce(`${READY_MARKER}${IDENTITY_MARKER}prompt`, {
      output: `${IDENTITY_MARKER}prompt`,
      shellPid: null,
      ready: true
    })
    expectEverySplitToProduce(`${READY_MARKER}\x1b[?2004hfish> `, {
      output: '\x1b[?2004hfish> ',
      shellPid: null,
      ready: true
    })
  })

  it('strips pre-ready markers at every chunk boundary', () => {
    expectEverySplitToProduce(`${IDENTITY_MARKER}${READY_MARKER}prompt`, {
      output: 'prompt',
      shellPid: 12345,
      ready: true
    })
  })

  it('strips identity and readiness markers from one chunk', () => {
    const state = createShellStartupOutputScanState()
    const scanned = scanShellStartupOutput(state, `${IDENTITY_MARKER}${READY_MARKER}prompt`)

    expect(scanned).toEqual({
      output: 'prompt',
      shellPid: 12345,
      ready: true,
      postMarkerBytesObserved: true
    })
  })

  it('counts an identity-held byte as post-marker output', () => {
    const state = createShellStartupOutputScanState()

    expect(scanShellStartupOutput(state, `${READY_MARKER}\x1b`)).toEqual({
      output: '\x1b',
      shellPid: null,
      ready: true,
      postMarkerBytesObserved: true
    })
  })

  it('drains every incomplete scanner prefix in byte order', () => {
    const state = createShellStartupOutputScanState()
    expect(scanShellStartupOutput(state, '\x1b]777;orca-shell-st').output).toBe('')

    expect(drainShellStartupOutputScanState(state)).toBe('\x1b]777;orca-shell-st')
  })

  it('drains simultaneous identity and readiness prefixes in input order', () => {
    const state = createShellStartupOutputScanState()
    expect(scanShellStartupOutput(state, '\x1b]777;orca-shell-st').output).toBe('')
    expect(scanShellStartupOutput(state, '\x1b]777;orca-shell-rea').output).toBe('')

    expect(drainShellStartupOutputScanState(state)).toBe(
      '\x1b]777;orca-shell-st\x1b]777;orca-shell-rea'
    )
  })
})
