import { describe, expect, it } from 'vitest'

import {
  countUnprovenPtyRetirements,
  isScannedPath
} from './check-unproven-pty-retirement-ratchet.mjs'

describe('countUnprovenPtyRetirements', () => {
  it('counts each unproven mint and each raw ownership drop', () => {
    expect(
      countUnprovenPtyRetirements(
        'const a = PtyRetirementWithoutProof.because(R)\nf(PtyRetirementWithoutProof.because("x"))'
      )
    ).toBe(2)
    expect(countUnprovenPtyRetirements('ptyOwnership.delete(id)\nptyOwnership.get(id)')).toBe(1)
  })

  it('ignores comments, proofs and the type name alone', () => {
    expect(
      countUnprovenPtyRetirements(
        '// PtyRetirementWithoutProof.because(r)\n/* PtyRetirementWithoutProof.because(r) */\n' +
          "PtyExitProof.from('absent')\nx instanceof PtyRetirementWithoutProof"
      )
    ).toBe(0)
  })
})

describe('isScannedPath', () => {
  it('scans production TypeScript only', () => {
    expect(isScannedPath('src/main/ipc/pty/runtime/kill.ts')).toBe(true)
    expect(isScannedPath('src/main/ipc/pty/runtime/kill.test.ts')).toBe(false)
    expect(isScannedPath('src/main/runtime/a.spec.ts')).toBe(false)
    expect(isScannedPath('src/main/ipc/pty/daemon-late-exit-test-fixture.ts')).toBe(false)
    expect(isScannedPath('src/main/ipc/pty/provider/liveness.ts')).toBe(false)
  })
})
