import { describe, expect, it } from 'vitest'
import type { MinidumpCrashSignature } from './minidump-crash-signature'
import {
  isRendererAllocationCheckCrash,
  noteRendererCrashSignature
} from './renderer-allocation-check-signatures'

// Scan-37 r29's parsed renderer dump.
const R29_SIGNATURE: MinidumpCrashSignature = {
  checkMessage:
    'SkBitmap.cpp:252: assertf(this->tryAllocPixels(info, rowBytes)): ColorType:4 AlphaType:3 [w:512 h:512] rb:0\n',
  processType: 'renderer',
  exceptionCode: 0x80000003,
  annotations: {}
}

describe('renderer allocation CHECK signatures', () => {
  it('pairs an allocation CHECK dump with the death it came from', () => {
    const crashedAtMs = 1_000_000
    noteRendererCrashSignature(crashedAtMs, R29_SIGNATURE)
    expect(isRendererAllocationCheckCrash(crashedAtMs + 3)).toBe(true)
    expect(isRendererAllocationCheckCrash(crashedAtMs + 2_886)).toBe(false)
  })

  let nextCrashAt = 2_000_000
  it.each([
    ['an ordinary CHECK', { checkMessage: '[1:FATAL:node.cc(12)] Check failed: !x.' }],
    ['a GPU dump', { processType: 'gpu-process' }],
    ['a non-breakpoint exception', { exceptionCode: 0xc0000005 }],
    ['a dump with no message', { checkMessage: undefined }]
  ])('ignores %s', (_label, override) => {
    const crashedAtMs = (nextCrashAt += 10_000)
    noteRendererCrashSignature(crashedAtMs, { ...R29_SIGNATURE, ...override })
    expect(isRendererAllocationCheckCrash(crashedAtMs)).toBe(false)
  })
})
