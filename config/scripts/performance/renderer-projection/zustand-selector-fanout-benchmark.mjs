#!/usr/bin/env node
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { createStore } from 'zustand/vanilla'

const SUBSCRIBERS = Number.parseInt(process.env.ORCA_ZUSTAND_BENCH_SUBSCRIBERS ?? '2500', 10)
const WRITES = Number.parseInt(process.env.ORCA_ZUSTAND_BENCH_WRITES ?? '2000', 10)
const MAX_MILLISECONDS_PER_WRITE = Number.parseFloat(
  process.env.ORCA_ZUSTAND_BENCH_MAX_MS_PER_WRITE ?? '5'
)

for (const [name, value] of [
  ['ORCA_ZUSTAND_BENCH_SUBSCRIBERS', SUBSCRIBERS],
  ['ORCA_ZUSTAND_BENCH_WRITES', WRITES],
  ['ORCA_ZUSTAND_BENCH_MAX_MS_PER_WRITE', MAX_MILLISECONDS_PER_WRITE]
]) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be positive, received ${value}`)
  }
}

function measureRound() {
  const stableProjection = Object.freeze({ activeRepoId: 'repo-1' })
  const store = createStore(() => ({ unrelatedWrite: 0, stableProjection }))
  let selectorRuns = 0
  let renderInvalidations = 0
  const unsubscribe = Array.from({ length: SUBSCRIBERS }, () => {
    let previous = store.getState().stableProjection
    return store.subscribe((state) => {
      selectorRuns += 1
      const next = state.stableProjection
      if (!Object.is(previous, next)) {
        renderInvalidations += 1
      }
      previous = next
    })
  })

  const start = performance.now()
  for (let index = 1; index <= WRITES; index += 1) {
    store.setState({ unrelatedWrite: index })
  }
  const elapsed = performance.now() - start
  for (const release of unsubscribe) {
    release()
  }
  return { elapsed, selectorRuns, renderInvalidations }
}

measureRound()
const rounds = Array.from({ length: 5 }, measureRound).sort(
  (left, right) => left.elapsed - right.elapsed
)
const median = rounds[2]
const expectedSelectorRuns = SUBSCRIBERS * WRITES
const millisecondsPerWrite = median.elapsed / WRITES

if (median.selectorRuns !== expectedSelectorRuns) {
  throw new Error(
    `Expected ${expectedSelectorRuns} selector runs, observed ${median.selectorRuns}; update the fan-out model.`
  )
}
if (median.renderInvalidations !== 0) {
  throw new Error(
    `${median.renderInvalidations} unrelated writes changed a stable selector result.`
  )
}

console.log(
  `Zustand fan-out: ${SUBSCRIBERS} subscribers × ${WRITES} unrelated writes = ${expectedSelectorRuns.toLocaleString()} selector runs`
)
console.log(
  `Median ${median.elapsed.toFixed(2)} ms total, ${millisecondsPerWrite.toFixed(4)} ms/write, 0 render invalidations`
)

if (process.argv.includes('--check') && millisecondsPerWrite > MAX_MILLISECONDS_PER_WRITE) {
  console.error(
    `Zustand fan-out exceeded ${MAX_MILLISECONDS_PER_WRITE.toFixed(2)} ms/write. Inspect selector work and store subscription growth.`
  )
  process.exit(1)
}
