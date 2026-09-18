#!/usr/bin/env node
// git show <base>:src/main/ipc/ssh-pty-source-obligation-state.ts | node config/scripts/ssh-source-frontier-benchmark.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'

const statePath = 'src/main/ipc/ssh-pty-source-obligation-state.ts'
const baselineSource = readFileSync(0, 'utf8')
assert(baselineSource.includes('export function advanceSourceTerminalEnd'))

async function loadLedger(source) {
  const result = await build({
    entryPoints: ['src/main/ipc/ssh-pty-source-obligation-ledger.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    plugins: [
      {
        name: 'source-obligation-state',
        setup(builder) {
          builder.onLoad({ filter: /ssh-pty-source-obligation-state\.ts$/ }, (args) => ({
            contents: source,
            loader: 'ts',
            resolveDir: path.dirname(args.path)
          }))
        }
      }
    ]
  })
  const encoded = Buffer.from(result.outputFiles[0].text).toString('base64')
  return (await import(`data:text/javascript;base64,${encoded}`)).SshPtySourceObligationLedger
}

const [Baseline, Current] = await Promise.all([
  loadLedger(baselineSource),
  loadLedger(readFileSync(statePath, 'utf8'))
])

function identity(index = 0) {
  return Object.freeze({
    id: `pty-${index}`,
    providerGeneration: index + 1,
    clientGeneration: 2,
    ownerGeneration: 3,
    ptyIncarnation: `incarnation-${index}`,
    deliveryToken: `token-${index}`
  })
}

function sourceSpan(owner, id, start, length) {
  return Object.freeze({
    ...owner,
    spanId: id,
    sourceStartSu: start,
    sourceEndSu: start + length,
    displayStart: start,
    displayEnd: start + length,
    data: 'x'.repeat(length),
    splittable: true,
    transform: Object.freeze({ transformed: false, rawLengthSu: length, scalarSafe: true })
  })
}

function trace(Ledger, seed) {
  let randomState = seed
  const random = (bound) => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
    return Math.floor((randomState / 2 ** 32) * bound)
  }
  const closed = []
  const ledger = new Ledger((owner) => closed.push(owner))
  const owners = [identity(), identity(1)]
  const starts = [seed % 3 === 0 ? Number.MAX_SAFE_INTEGER - 10_000 : 0, 100]
  const reservations = []
  const publications = []
  const spans = []
  const consumers = ['model', 'desktop', 'remote:viewer']
  owners.forEach((owner, index) => ledger.open(owner, starts[index]))
  const results = []
  const rememberAck = (publication) => {
    if (publication) {
      publications.push(publication)
    }
    return publication?.ack ?? null
  }
  for (let step = 0; step < 120; step += 1) {
    const owner = owners[random(owners.length)]
    const selectedSpan = spans[random(spans.length)]
    const spanId = selectedSpan?.spanId ?? 'missing'
    const consumer = consumers[random(consumers.length)]
    const operation = step < 20 ? random(2) : random(14)
    try {
      let value
      switch (operation) {
        case 0:
        case 1: {
          const start = ledger.snapshot(owner).receivedEndSu
          const span = sourceSpan(owner, `span-${step}`, start, random(5))
          spans.push(span)
          const reservation = ledger.reserve(owner, span, consumers)
          reservations.push(reservation)
          value = random(8) === 0 ? ledger.rollback(reservation) : ledger.commit(reservation)
          break
        }
        case 2:
        case 3:
          value = ledger.settle(spanId, consumer, 'accepted')
          break
        case 4:
          value = ledger.beginTransfer(spanId, consumer, 'model', 'hidden')
          break
        case 5:
          value = ledger.commitTransfer(spanId, consumer)
          break
        case 6:
          value = ledger.cancelTransfer(spanId, consumer, 'canceled')
          break
        case 7:
          value = ledger.rollbackTransfer(spanId, consumer)
          break
        case 8:
          value = rememberAck(ledger.queueAck(owner))
          break
        case 9:
          value = rememberAck(ledger.retryQueuedAck(owner))
          break
        case 10: {
          const publication = publications[random(publications.length)]
          const result = random(4) ? { ok: true } : { ok: false, error: new Error('write failed') }
          value = publication?.onSettled(result)
          break
        }
        case 11: {
          const reservation = reservations[random(reservations.length)]
          value = reservation ? ledger.rollbackCommitted(reservation) : false
          break
        }
        case 12:
          value = ledger.modelAcceptedEnd(owner)
          break
        case 13:
          value = step < 100 ? ledger.spanIdentity(spanId) : ledger.seal(owner)
          break
      }
      results.push({ operation, value })
    } catch (error) {
      results.push({ operation, error: [error.name, error.message] })
    }
    results.push(owners.map((entry) => ledger.snapshot(entry)))
  }
  for (const span of spans) {
    if (ledger.hasRetainedSpan(span.spanId)) {
      results.push(consumers.map((consumer) => ledger.obligation(span.spanId, consumer)))
      for (const consumer of consumers) {
        const obligation = ledger.obligation(span.spanId, consumer)
        if (obligation.state === 'open') {
          ledger.settle(span.spanId, consumer, 'drained')
        } else if (obligation.state === 'transferring') {
          ledger.commitTransfer(span.spanId, consumer)
        }
      }
      results.push(owners.map((owner) => ledger.snapshot(owner)))
      rememberAck(ledger.queueAck(span))
      if (random(3) === 0) {
        publications[random(publications.length)]?.onSettled({ ok: true })
      }
    } else {
      results.push(null)
    }
  }
  results.push(ledger.closeGeneration(1, 'connection closed'))
  for (const publication of publications) {
    publication.onSettled({ ok: true })
  }
  results.push(
    ledger.closeAll('disposed'),
    closed,
    owners.map((owner) => ledger.snapshot(owner))
  )
  return results
}

for (let seed = 1; seed <= 2_000; seed += 1) {
  assert.deepEqual(trace(Current, seed), trace(Baseline, seed), `seed ${seed}`)
}
console.log('2,000 differential traces / 240,000 commands passed (plus snapshots and cleanup).')

function runBatch(Ledger, spans, mode) {
  const ledger = new Ledger()
  const owner = spans[0]
  ledger.open(owner)
  const settle = (span) => {
    ledger.settle(span.spanId, 'model', 'accepted')
    ledger.settle(span.spanId, 'desktop', 'parsed')
  }
  for (const span of spans) {
    ledger.commit(ledger.reserve(owner, span, ['model', 'desktop']))
    if (mode !== 'backlog') {
      settle(span)
      if (mode === 'immediate') {
        ledger.queueAck(owner)?.onSettled({ ok: true })
      }
    }
  }
  if (mode === 'backlog') {
    for (const span of spans) {
      settle(span)
    }
  }
  ledger.queueAck(owner)?.onSettled({ ok: true })
  return ledger.snapshot(owner)
}

function median(values) {
  const ordered = values.toSorted((left, right) => left - right)
  return (ordered[ordered.length / 2 - 1] + ordered[ordered.length / 2]) / 2
}

console.log(
  JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch })
)
const rows = []
for (const mode of ['immediate', 'delayed', 'backlog']) {
  for (const count of [1, 16, 64, 256, 1_024]) {
    const spans = Array.from({ length: count }, (_, index) =>
      sourceSpan(identity(), `span-${index}`, index * 128, 128)
    )
    const expected = runBatch(Baseline, spans, mode)
    assert.deepEqual(runBatch(Current, spans, mode), expected)
    const iterations = Math.max(20, Math.floor(8_192 / count))
    const measure = (Ledger) => {
      let result
      const start = performance.now()
      for (let index = 0; index < iterations; index += 1) {
        result = runBatch(Ledger, spans, mode)
      }
      const elapsed = (performance.now() - start) / iterations
      assert.deepEqual(result, expected)
      return elapsed
    }
    measure(Baseline)
    measure(Current)
    const samples = { baseline: [], current: [] }
    for (const pair of buildCounterbalancedSchedule(8, 'baseline', 'current')) {
      for (const arm of pair) {
        samples[arm].push(measure(arm === 'baseline' ? Baseline : Current))
      }
    }
    rows.push({
      mode,
      spans: count,
      beforeMs: median(samples.baseline),
      afterMs: median(samples.current)
    })
  }
}
console.table(rows)
console.log('Synthetic ledger CPU only; no network, renderer, or end-to-end latency measurement.')
