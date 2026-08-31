import { describe, expect, it } from 'vitest'
import { normalizeOmpPromptInput, OmpPromptReadiness } from './omp-prompt-readiness'

const ready = '\x1b]777;orca-omp-prompt;ready\x07'
const blocked = '\x1b]777;orca-omp-prompt;blocked\x07'

describe('OMP startup readiness', () => {
  it('matches OMP paste and submit normalization without removing ordinary Unicode', () => {
    expect(
      normalizeOmpPromptInput('  中文e\u0301 🐳\r\nL2\rL3\tT\u0007B\u000bV\u001fU<ESC>X  ')
    ).toBe('中文é 🐳\nL2\nL3   TBVU<ESC>X')
  })
  it('does not infer submit readiness from an idle-looking title', () => {
    const state = new OmpPromptReadiness()
    state.ingest('\x1b]0;π > workspace\x07')
    expect(state.ready).toBe(false)
  })

  it('handles every split point with BEL and ST terminators', () => {
    for (const frame of [ready, `${ready.slice(0, -1)}\x1b\\`]) {
      for (let split = 1; split < frame.length; split++) {
        const state = new OmpPromptReadiness()
        state.ingest(frame.slice(0, split))
        expect(state.ready).toBe(false)
        state.ingest(frame.slice(split))
        expect(state.ready).toBe(true)
      }
    }
  })

  it('applies reset and readiness frames in byte order', () => {
    for (const reset of [blocked, '\x1b]0;omp\x07', '\x1b]133;D;0\x07']) {
      const state = new OmpPromptReadiness()
      state.ingest(ready + reset)
      expect(state.ready).toBe(false)
      state.ingest(reset + ready)
      expect(state.ready).toBe(true)
    }
  })

  it('counts completed submission frames independently from readiness', () => {
    const fingerprint = 'a'.repeat(64)
    const frame = `\x1b]777;orca-omp-prompt;submitted;${fingerprint}\x07`
    for (const terminated of [frame, `${frame.slice(0, -1)}\x1b\\`]) {
      for (let split = 1; split < terminated.length; split++) {
        const state = new OmpPromptReadiness()
        state.ingest(ready)
        expect(state.submittedSequence).toBe(0)
        state.ingest(terminated.slice(0, split))
        expect(state.submittedSequence).toBe(0)
        state.ingest(terminated.slice(split))
        expect(state.submittedSequence).toBe(1)
        expect(state.submittedFingerprint).toBe(fingerprint)
        expect(state.ready).toBe(false)
        state.reset()
        expect(state.submittedFingerprint).toBeNull()
        state.ingest(frame)
        expect(state.submittedSequence).toBe(2)
      }
    }
  })

  it('ignores uncorrelated or malformed submission markers', () => {
    const state = new OmpPromptReadiness()
    for (const suffix of ['', ';abc', `;${'a'.repeat(65)}`, `;${'z'.repeat(64)}`]) {
      state.ingest(`\x1b]777;orca-omp-prompt;submitted${suffix}\x07`)
    }
    expect(state.submittedSequence).toBe(0)
    expect(state.submittedFingerprint).toBeNull()
  })

  it('does not trust unknown or unterminated payloads', () => {
    const state = new OmpPromptReadiness()
    state.ingest('777;orca-omp-prompt;ready\x07')
    state.ingest('\x1b]777;orca-omp-prompt;ready-but-not-really\x07')
    state.ingest(ready.slice(0, -1))
    expect(state.ready).toBe(false)
    state.reset()
    state.ingest('\x07')
    expect(state.ready).toBe(false)
  })

  it('recovers from oversized and nested incomplete OSCs', () => {
    const state = new OmpPromptReadiness()
    state.ingest(`\x1b]${'x'.repeat(1_000)}`)
    state.ingest(`\x1b]unterminated${ready}`)
    expect(state.ready).toBe(true)
    state.reset()
    expect(state.ready).toBe(false)
  })
})
