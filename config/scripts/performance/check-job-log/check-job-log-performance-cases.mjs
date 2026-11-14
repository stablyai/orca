import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createCheckLogFixture } from './check-job-log-test-fixture.mjs'

export const BASELINE_REF = 'c745051d7d6885b86f27120b616f15396404ba3d'
export const BASELINE_SOURCE_HASHES = {
  'ansi-escape-sequences.ts': '75c79a88fb91c8b7a128a1ccc133051cde9e3e09f553d4d4fbb8887f89b6d217',
  'check-job-log-tail-slice.ts': '24ccf1fc3a0a5b2da7eb3a218a7b3fb7e85e6100e8b60e0b7f6c9fe5665413e4',
  'utf8-byte-limits.ts': '01574b287b2d6ab0758112887e356c0d270b25db1b72651925ba8329eb4224e6',
  'own-retained-string.ts': 'addea88bc11c725192be2ff617b91315a875113844c95de03e5529cf3d7ef2e2',
  'owned-utf16-suffix.ts': '1ca0bb35dfff2d9f3c02caee3d05b0e0c97378df71c878622acf703524d2c475'
}
export const LIMIT = 16 * 1024
export const SEED = 0xc0ffee16
const mib = 1024 * 1024
export const directSizes = [
  16 * 1024,
  32 * 1024,
  mib,
  2 * mib,
  8 * mib,
  16 * mib,
  31.5 * mib,
  63 * mib
]
export const extractionSizes = [16 * 1024, 32 * 1024, 2 * mib, 8 * mib, 63 * mib]
export const families = [
  ...[
    ['osc', '\x1b]', '\x9d'],
    ['dcs', '\x1bP', '\x90'],
    ['apc', '\x1b_', '\x9f'],
    ['pm', '\x1b^', '\x9e'],
    ['sos', '\x1bX', '\x98'],
    ['csi', '\x1b[', '\x9b']
  ].flatMap(([family, seven, eight]) => [
    { family, width: 7, pattern: `${seven}111`, survivor: '111', adverse: family !== 'csi' },
    { family, width: 8, pattern: `${eight}111`, survivor: `${eight}111`, adverse: family !== 'csi' }
  ]),
  { family: 'partial-esc', width: 7, pattern: '\x1b ', survivor: '\x1b ', adverse: false },
  { family: 'dense-osc', width: 7, pattern: '\x1b]body\x07x', survivor: 'x', adverse: false },
  { family: 'dense-osc', width: 8, pattern: '\x9dbody\x9cx', survivor: 'x', adverse: false },
  { family: 'dense-string', width: 7, pattern: '\x1bPbody\x1b\\x', survivor: 'x', adverse: false },
  { family: 'dense-string', width: 8, pattern: '\x90body\x9cx', survivor: 'x', adverse: false },
  {
    family: 'mixed',
    width: 0,
    pattern: '\x1b]a\x07界\x90b\x9cx\x1b[31m😀\x1b[0m',
    survivor: '界x😀',
    adverse: false
  },
  {
    family: 'sparse',
    width: 7,
    pattern: `${'a'.repeat(4096)}\x1b]body\x07`,
    survivor: 'a'.repeat(4096),
    adverse: false
  },
  {
    family: 'plain',
    width: 0,
    pattern: 'ordinary 界😀 text ',
    survivor: 'ordinary 界😀 text ',
    adverse: false
  }
]

export function repeatBytes(pattern, bytes) {
  const width = Buffer.byteLength(pattern)
  const copies = Math.floor(bytes / width)
  return {
    text: pattern.repeat(copies) + 'x'.repeat(bytes - copies * width),
    copies,
    padding: bytes - copies * width
  }
}

export function workload(descriptor) {
  if (descriptor.mode === 'cpu') {
    if (descriptor.family === 'actual') {
      return { text: readFileSync(descriptor.capturePath, 'utf8') }
    }
    if (descriptor.family === 'fixture') {
      return { text: createCheckLogFixture().rawLog }
    }
    const line = '2026-10-10T05:41:30.4306569Z \x1b[32mordinary successful output 界\x1b[0m\n'
    const suffix = '\n\x1b[31merror: CPU_DIAGNOSTIC\x1b[0m\n  at CPU_FRAME.ts:18:8\n'
    return { text: repeatBytes(line, descriptor.bytes - Buffer.byteLength(suffix)).text + suffix }
  }
  const family = families.find(
    (value) => value.family === descriptor.family && value.width === descriptor.width
  )
  assert(family, 'unknown family')
  const terminator =
    descriptor.variant === 'late'
      ? family.family === 'csi'
        ? 'm'
        : family.family === 'partial-esc'
          ? '@'
          : descriptor.terminator
      : ''
  const prefix =
    descriptor.mode === 'coverage' && descriptor.position === 'earlier' ? 'error: EDGE ' : ''
  const generated = repeatBytes(
    family.pattern,
    descriptor.bytes - Buffer.byteLength(terminator) - Buffer.byteLength(prefix)
  )
  const text = prefix + generated.text + terminator
  let expected = family.survivor.repeat(generated.copies) + 'x'.repeat(generated.padding)
  if (family.family === 'csi' && generated.padding > 0) {
    expected =
      family.survivor.repeat(Math.max(0, generated.copies - 1)) + 'x'.repeat(generated.padding - 1)
  }
  if (terminator) {
    if (family.adverse) {
      expected = ''
    } else if (family.family === 'csi') {
      expected = family.survivor.repeat(Math.max(0, generated.copies - 1))
    } else if (family.family === 'partial-esc') {
      expected = family.survivor.repeat(Math.max(0, generated.copies - 1))
    }
  }
  if (descriptor.mode === 'coverage') {
    const tail = Array.from({ length: 210 }, (_, index) => `recent ${index}`).join('\n')
    return {
      text:
        descriptor.position === 'earlier'
          ? `${text}\n${tail}`
          : descriptor.position === 'tail'
            ? `${tail}\n${text}`
            : `${text}\n${tail}`,
      lineBytes: descriptor.bytes
    }
  }
  return { text, expected }
}

function item(mode, arm, fields) {
  const value = {
    mode,
    arm,
    variant: 'unfinished',
    seed: SEED,
    generator: 'repeated-byte-pattern-v1',
    ...fields
  }
  value.id = [
    mode,
    arm,
    value.family,
    value.width,
    value.bytes,
    value.position,
    value.variant,
    value.terminator === '\x1b\\'
      ? 'st7'
      : value.terminator === '\x9c'
        ? 'st8'
        : value.terminator === '\x07'
          ? 'bel'
          : '',
    value.sample,
    value.noBuffer ? 'no-buffer' : ''
  ]
    .filter((x) => x !== undefined)
    .join(':')
  return value
}

export function createManifest({ capturePath } = {}) {
  const manifest = [
    item('control', 'proposed', { family: 'monitor', sample: 0 }),
    item('control', 'proposed', { family: 'cleanup', sample: 0 }),
    item('watchdog', 'proposed', { family: 'watchdog', sample: 0 })
  ]
  for (const family of families.slice(0, 13)) {
    for (const bytes of extractionSizes) {
      for (const position of ['earlier', 'tail', 'fallback']) {
        for (const variant of ['unfinished', 'late']) {
          for (const terminator of variant === 'late' && family.adverse
            ? ['\x1b\\', '\x9c', ...(family.family === 'osc' ? ['\x07'] : [])]
            : ['']) {
            manifest.push(
              item('coverage', 'proposed', {
                family: family.family,
                width: family.width,
                bytes,
                position,
                variant,
                terminator
              })
            )
          }
        }
      }
    }
  }
  for (const arm of ['proposed', 'baseline']) {
    manifest.push(item('differential', arm, { family: 'plain-lf' }))
  }
  for (const family of families) {
    for (const bytes of [16 * 1024, 32 * 1024]) {
      manifest.push(
        item('counts', 'proposed', { family: family.family, width: family.width, bytes })
      )
    }
  }
  for (const family of families.filter((value) =>
    ['dense-osc', 'dense-string', 'mixed', 'sparse'].includes(value.family)
  )) {
    for (const bytes of [16 * 1024, 32 * 1024]) {
      manifest.push(
        item('counts', 'proposed', {
          family: family.family,
          width: family.width,
          bytes,
          noBuffer: true
        })
      )
    }
  }
  // Parent ordering alternates every direct pair; each child gets fresh three warmups.
  for (const family of families) {
    for (let pair = 0; pair < directSizes.length; pair += 2) {
      const sizes = directSizes.slice(pair, pair + 2)
      for (let sample = 0; sample < 7; sample++) {
        for (const arm of sample % 2 ? ['baseline', 'proposed'] : ['proposed', 'baseline']) {
          for (const bytes of sample % 2 ? sizes.toReversed() : sizes) {
            manifest.push(
              item('direct', arm, {
                family: family.family,
                width: family.width,
                bytes,
                sample,
                samples: 1,
                baselineTimeoutAllowed: arm === 'baseline' && family.adverse
              })
            )
          }
        }
      }
    }
  }
  const cpuCases = [
    { family: 'fixture', bytes: 0, samples: 15, warmups: 3 },
    ...(capturePath ? [{ family: 'actual', capturePath, bytes: 0, samples: 15, warmups: 3 }] : []),
    ...[8 * mib, 63 * mib].map((bytes) => ({
      family: 'short-lines',
      bytes,
      samples: 5,
      warmups: 1
    }))
  ]
  for (const fields of cpuCases) {
    for (let sample = 0; sample < fields.samples; sample++) {
      for (const arm of sample % 2
        ? ['full-log', 'baseline-bounded', 'proposed', 'baseline']
        : ['baseline', 'proposed', 'baseline-bounded', 'full-log']) {
        manifest.push(item('cpu', arm, { ...fields, samples: 1, sample }))
      }
    }
  }
  for (const arm of ['pinned', 'baseline', 'proposed', 'no-buffer']) {
    manifest.push(item('retention', arm, { family: 'eight-parents' }))
  }
  for (const arm of ['proposed', 'no-buffer']) {
    manifest.push(item('retention', arm, { family: 'cache', count: 128 }))
  }
  manifest.push(item('retention', 'proposed', { family: 'near-cap', count: 3 }))
  return manifest
}

export function selectRequiredDescriptors(manifest) {
  return manifest.filter((descriptor) => {
    if (descriptor.mode === 'coverage') {
      return (
        ['osc', 'dcs', 'apc', 'pm', 'sos'].includes(descriptor.family) &&
        [16 * 1024, 32 * 1024, 2 * mib, 63 * mib].includes(descriptor.bytes) &&
        ['earlier', 'tail'].includes(descriptor.position) &&
        descriptor.variant === 'unfinished'
      )
    }
    if (descriptor.mode === 'direct') {
      return (
        descriptor.bytes <= 32 * 1024 ||
        (descriptor.arm === 'proposed' &&
          descriptor.bytes >= 31.5 * mib &&
          ['osc', 'dcs', 'dense-osc', 'dense-string', 'mixed', 'sparse'].includes(
            descriptor.family
          ))
      )
    }
    return true
  })
}
