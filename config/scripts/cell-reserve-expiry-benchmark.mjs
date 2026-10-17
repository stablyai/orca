import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '../..')
const sourcePath = path.join(root, 'cloud/apps/relay/src/cell-reserve-book.ts')
const ledgerPath = path.join(root, 'cloud/apps/relay/src/relay-connection-ledger.ts')
const host = 'abcdefghijklmnop'
const context = { mode: 'reserve', draining: false, seatedEpoch: () => undefined }
const rows = Array.from({ length: 2_840 }, (_, index) => booking(`user-${index}`))
const baselineFlag = process.argv.indexOf('--baseline')
const baselinePath = baselineFlag === -1 ? undefined : process.argv[baselineFlag + 1]
if (!baselinePath) {
  throw new Error(
    'Usage: node config/scripts/cell-reserve-expiry-benchmark.mjs --baseline <source.ts> [--parity-only]'
  )
}
const [beforeSource, afterSource] = await Promise.all([
  readFile(baselinePath, 'utf8'),
  readFile(sourcePath, 'utf8')
])
if (beforeSource.trim() === afterSource.trim()) {
  throw new Error('Baseline and current source are identical')
}
const temporary = await mkdtemp(path.join(os.tmpdir(), 'orca-reserve-expiry-'))
try {
  const [before, after, ledger] = await Promise.all([
    loadSource(beforeSource, sourcePath, 'before'),
    loadSource(afterSource, sourcePath, 'after'),
    loadSource(await readFile(ledgerPath, 'utf8'), ledgerPath, 'ledger')
  ])
  const classes = { before: before.CellReserveBook, after: after.CellReserveBook }
  const Ledger = ledger.RelayConnectionLedger
  for (let seed = 1; seed <= 12; seed++) {
    assert.deepEqual(parity(classes.before, Ledger, seed), parity(classes.after, Ledger, seed))
  }
  assert.deepEqual(releaseFailure(classes.before, Ledger), releaseFailure(classes.after, Ledger))
  const output = {
    runtime: { platform: process.platform, arch: process.arch, node: process.version },
    paritySeeds: 12,
    operationsPerSeed: 1_000,
    releaseFailureParity: true,
    measurements: {}
  }
  if (!process.argv.includes('--parity-only')) {
    for (const scenario of [
      'restart2840',
      'renew320',
      'renew2840',
      'ordinary1000',
      'expiry2840',
      'mixedExpiry100'
    ]) {
      const samples = { before: [], after: [] }
      for (let pair = 0; pair < 12; pair++) {
        const order = pair % 2 === 0 ? ['before', 'after'] : ['after', 'before']
        for (const name of order) {
          const measure = prepare(classes[name], Ledger, scenario)
          const started = performance.now()
          measure()
          const duration = performance.now() - started
          if (pair >= 3) {
            samples[name].push(duration)
          }
        }
      }
      output.measurements[scenario] = {
        beforeMedianMs: median(samples.before),
        afterMedianMs: median(samples.after),
        samples
      }
    }
  }
  // Instrument only after timing: restoring a patched iterator does not restore V8's protector.
  const readCounts = Object.fromEntries(
    Object.entries(classes).map(([name, Book]) => {
      const fixture = create(Book, Ledger)
      const rebuildVisits = countVisits(() => fill(fixture.book, 2_840))
      const renewalVisits = countVisits(() => renew(fixture.book, 64))
      return [name, { rebuildVisits, renewalVisits }]
    })
  )
  assert.equal(readCounts.after.rebuildVisits, 0)
  assert.equal(readCounts.after.renewalVisits, 0)
  assert.equal(readCounts.before.rebuildVisits, (2_840 * 2_839) / 2)
  assert.equal(readCounts.before.renewalVisits, 2_840 * 64)
  output.readCounts = readCounts
  console.log(JSON.stringify(output, null, 2))
} finally {
  await rm(temporary, { recursive: true, force: true })
}

async function loadSource(contents, productionPath, name) {
  const result = await build({
    stdin: {
      contents,
      loader: 'ts',
      resolveDir: path.dirname(productionPath),
      sourcefile: productionPath
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'es2024',
    write: false,
    logLevel: 'silent'
  })
  const modulePath = path.join(temporary, `${name}.mjs`)
  await writeFile(modulePath, result.outputFiles[0].text)
  return import(pathToFileURL(modulePath).href)
}

function booking(userId, epoch = 2, ttlMs = 30_000, sticky = true) {
  return { userId, relayHostId: host, epoch, ttlMs, sticky }
}

function create(Book, Ledger, limit = 2_840, release = () => {}) {
  let now = 0
  const ledger = new Ledger(3_000, 100)
  const book = new Book(
    {
      canReserve: () => ledger.canReserveBooking(limit),
      tryReserve: () => {
        const unit = ledger.tryReserveBooking(limit)
        if (!unit) {
          return null
        }
        return {
          release: () => {
            release()
            unit.release()
          }
        }
      }
    },
    () => 10,
    () => now
  )
  return {
    book,
    ledger,
    at: (value) => {
      now = value
    }
  }
}

function fill(book, count) {
  for (let index = 0; index < count; index++) {
    assert.equal(book.reserve('director', rows[index], context).outcome, 'ok')
  }
}

function renew(book, count) {
  for (let index = 0; index < count; index++) {
    book.reserve('director', rows[index % 64], context)
  }
}

function countVisits(operation) {
  let visits = 0
  const entries = Map.prototype[Symbol.iterator]
  Map.prototype[Symbol.iterator] = function () {
    const iterator = entries.call(this)
    const next = iterator.next.bind(iterator)
    iterator.next = () => {
      const result = next()
      if (!result.done) {
        visits++
      }
      return result
    }
    return iterator
  }
  try {
    operation()
    return visits
  } finally {
    Map.prototype[Symbol.iterator] = entries
  }
}

function parity(Book, Ledger, seed) {
  let randomState = seed
  const random = (max) => {
    randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0
    return randomState % max
  }
  let releases = 0
  const fixture = create(Book, Ledger, 12, () => {
    releases++
  })
  const { book, ledger } = fixture
  const trace = []
  let now = 0
  for (let step = 0; step < 1_000; step++) {
    now += random(61) - 10
    fixture.at(now)
    const user = `user-${random(20)}`
    const epoch = 1 + random(4)
    let result
    switch (random(10)) {
      case 0:
        result = book.take(user, host, epoch)
        break
      case 1:
        book.handOff(user, host)
        break
      case 2:
        book.sweep()
        break
      case 3:
        book.clear()
        break
      default:
        result = book.reserve(
          'director',
          booking(user, epoch, 1 + random(500), random(2) === 0),
          {
            mode: random(8) === 0 ? 'db' : 'reserve',
            draining: random(8) === 0,
            seatedEpoch: () => (random(5) === 0 ? epoch : undefined)
          },
          random(5) === 0
        )
    }
    trace.push({
      result,
      releases,
      count: book.count(),
      counts: ledger.counts(),
      intake: book.intakeSnapshot(),
      has: book.has(user, host)
    })
  }
  fixture.at(1_000_000)
  book.sweep()
  trace.push({ count: book.count(), counts: ledger.counts(), releases })
  return trace
}

function releaseFailure(Book, Ledger) {
  let failures = 1
  let releases = 0
  const fixture = create(Book, Ledger, 12, () => {
    if (failures-- > 0) {
      throw new Error('release failed')
    }
    releases++
  })
  fill(fixture.book, 3)
  const trace = []
  for (let attempt = 0; attempt < 2; attempt++) {
    let error
    try {
      fixture.book.sweep(30_000)
    } catch (caught) {
      error = caught.message
    }
    trace.push({ error, releases, count: fixture.book.count(), counts: fixture.ledger.counts() })
  }
  return trace
}

function prepare(Book, Ledger, scenario) {
  const fixture = create(Book, Ledger)
  if (scenario === 'mixedExpiry100') {
    fill(fixture.book, 2_839)
    const short = booking('short', 2, 1)
    return () => {
      for (let index = 0; index < 100; index++) {
        fixture.at(index)
        fixture.book.reserve('director', short, context)
      }
    }
  }
  if (scenario === 'restart2840') {
    return () => {
      for (const row of rows) {
        fixture.book.reserve('director', row, context)
      }
      assert.equal(fixture.book.count(), 2_840)
    }
  }
  if (scenario.startsWith('renew')) {
    fill(fixture.book, scenario === 'renew320' ? 320 : 2_840)
    return () => renew(fixture.book, 64 * 100)
  }
  if (scenario === 'expiry2840') {
    fill(fixture.book, 2_840)
    return () => {
      fixture.book.sweep(30_000)
      assert.equal(fixture.book.count(), 0)
      assert.equal(fixture.ledger.counts().reservedConnectionUnits, 0)
    }
  }
  return () => {
    for (let index = 0; index < 1_000; index++) {
      fixture.at(index * 31_000)
      fixture.book.reserve('director', rows[0], context)
      fixture.book.take(rows[0].userId, host, rows[0].epoch)
    }
    assert.equal(fixture.book.count(), 0)
  }
}

function median(samples) {
  return [...samples].sort((left, right) => left - right)[Math.floor(samples.length / 2)]
}
