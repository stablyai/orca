import assert from 'node:assert/strict'
import { BASELINE_REF } from './check-job-log-performance-cases.mjs'

export function assertWatchdogExit(result) {
  const signalExit = result.code === null && ['SIGTERM', 'SIGKILL'].includes(result.signal)
  assert(result.timedOut === true && signalExit, 'Unverified watchdog termination')
}

export function assertMeasurementRuntime(runtime) {
  assert(
    runtime?.bun === false &&
      typeof runtime.node === 'string' &&
      /^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(runtime.node) &&
      typeof runtime.platform === 'string' &&
      /^[a-z][a-z0-9]*$/.test(runtime.platform) &&
      typeof runtime.arch === 'string' &&
      /^[a-z][a-z0-9]*$/.test(runtime.arch),
    'Measurement requires verified Node'
  )
}

export function validateChildProtocol(stdout, descriptor) {
  const protocol = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  assert(protocol.every((record) => record && typeof record === 'object'))
  const readyRecords = protocol.filter((record) => record.type === 'ready')
  const completed = protocol.filter((record) => record.type === 'result')
  assert(readyRecords.length === 1 && protocol[0] === readyRecords[0], 'Invalid ready framing')
  assert(
    completed.length <= 1 && (!completed.length || protocol.at(-1) === completed[0]),
    'Invalid result framing'
  )
  const ready = readyRecords[0]
  assertMeasurementRuntime(ready.runtime)
  if (completed.length) {
    for (const field of ['id', 'mode', 'arm']) {
      assert.equal(completed[0][field], descriptor[field], `Completion ${field} changed`)
    }
    assert.deepEqual(
      completed[0].inputIdentity,
      { inputBytes: ready.inputBytes, codeUnits: ready.codeUnits, inputHash: ready.inputHash },
      'Completion input identity changed'
    )
  }
  const entries = protocol.slice(1, completed.length ? -1 : undefined)
  let entered
  let pendingStrip
  let warmups = 0
  let samples = 0
  for (const entry of entries) {
    if (descriptor.mode === 'watchdog') {
      assert(
        entries.length === 1 && entry.type === 'entered' && entry.phase === 'watchdog',
        'Invalid watchdog entry'
      )
    } else if (entry.type === 'entered-strip') {
      assert(
        descriptor.baselineTimeoutAllowed &&
          descriptor.mode === 'direct' &&
          descriptor.arm === 'baseline' &&
          ['warmup', 'sample'].includes(entry.phase) &&
          ((pendingStrip && pendingStrip.phase === entry.phase) || entries.length === 1),
        'Invalid strip entry'
      )
      pendingStrip = undefined
    } else {
      assert(
        ['direct', 'cpu'].includes(descriptor.mode) && entry.type === 'entered' && !pendingStrip,
        'Invalid workload entry'
      )
      if (entry.phase === 'warmup') {
        assert(samples === 0 && warmups < (descriptor.warmups ?? 3))
        assert.equal(entry.warmup, warmups++, 'Invalid warmup order')
      } else {
        assert(entry.phase === 'sample' && warmups === (descriptor.warmups ?? 3))
        assert(samples < descriptor.samples)
        assert.equal(entry.sample, samples++, 'Invalid sample order')
      }
      if (descriptor.baselineTimeoutAllowed) {
        pendingStrip = entry
      }
    }
    entered =
      entry.type === (descriptor.baselineTimeoutAllowed ? 'entered-strip' : 'entered')
        ? entry
        : undefined
  }
  assert(!completed.length || !pendingStrip, 'Completion preceded strip entry')
  return { ready, entered, completed, warmups }
}

export const adverseCaseKey = (descriptor) =>
  JSON.stringify([
    descriptor.family,
    descriptor.width,
    descriptor.bytes,
    descriptor.variant,
    descriptor.terminator,
    descriptor.seed,
    descriptor.generator
  ])

export function auditBaselineCensoring(manifest, byId) {
  for (const descriptor of manifest) {
    const record = byId.get(descriptor.id)
    if (descriptor.mode === 'watchdog' || record.status === 'watchdog_passed') {
      assert(
        descriptor.mode === 'watchdog' &&
          record.status === 'watchdog_passed' &&
          record.attempted === true
      )
      assert(record.settlementMs < 15000)
      assert.equal(record.identity.baselineRef, BASELINE_REF)
      assertMeasurementRuntime(record.runtime)
      assertWatchdogExit(record.watchdogTermination)
      assert.equal(record.code, record.watchdogTermination.code)
      assert.equal(record.signal, record.watchdogTermination.signal)
    }
    if (record.status === 'baseline_timeout') {
      assert(
        descriptor.baselineTimeoutAllowed &&
          descriptor.arm === 'baseline' &&
          descriptor.mode === 'direct'
      )
      assert(record.attempted === true && ['warmup', 'sample'].includes(record.phase))
      assert.equal(record.deadlineMs, 10000)
      assert(record.settlementMs < 15000)
      assert.equal(record.identity.baselineRef, BASELINE_REF)
      assertMeasurementRuntime(record.runtime)
      assertWatchdogExit(record.watchdogTermination)
    }
    if (record.status === 'baseline_censored') {
      const initial = byId.get(record.initialTimeoutId)
      assert(
        descriptor.baselineTimeoutAllowed && descriptor.sample > 0 && record.attempted === false
      )
      assert(
        initial?.status === 'baseline_timeout' &&
          initial.sample === 0 &&
          initial.attempted === true,
        'Missing verified initial adverse attempt'
      )
      assert.equal(
        adverseCaseKey(record),
        adverseCaseKey(initial),
        'Censoring crossed adverse cases'
      )
      assertWatchdogExit(initial.watchdogTermination)
      assert.deepEqual(record.identity, { ...initial.identity, id: descriptor.id })
      for (const field of ['inputBytes', 'codeUnits', 'inputHash']) {
        assert.equal(record[field], initial[field])
      }
    }
  }
  for (const descriptor of manifest.filter(
    (item) => item.mode === 'direct' && item.baselineTimeoutAllowed && item.sample === 0
  )) {
    const slots = manifest.filter(
      (item) =>
        item.mode === 'direct' &&
        item.baselineTimeoutAllowed &&
        adverseCaseKey(item) === adverseCaseKey(descriptor)
    )
    assert.equal(slots.length, 7, 'Incomplete adverse baseline logical slots')
    assert.deepEqual(
      slots.map((item) => item.sample).toSorted((a, b) => a - b),
      [0, 1, 2, 3, 4, 5, 6]
    )
    for (const slot of slots) {
      const record = byId.get(slot.id)
      assert(
        record.attempted === true || record.status === 'baseline_censored',
        'Unattempted baseline sample'
      )
      assert.equal(
        record.status === 'completed' ? record.samples.length : record.unavailableSamples,
        1
      )
    }
  }
}
