import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1')
}

const cases = ['live', 'overwrite', 'erase', 'cache', 'scratch']
const ownPath = import.meta.filename
const require = createRequire(import.meta.url)
const marks = 100_000
const rows = 8

async function measure(bundle, scenario, alternate) {
  assert.equal(typeof global.gc, 'function', 'Pass --expose-gc')
  const loaded = bundle.endsWith('.mjs')
    ? await import(pathToFileURL(bundle).href)
    : require(bundle)
  const { Terminal } = loaded
  const { Unicode11Addon } = require('@xterm/addon-unicode11')
  const terminal = new Terminal({
    cols: 12,
    rows: 10,
    scrollback: 0,
    allowProposedApi: true,
    logLevel: 'off'
  })
  terminal.loadAddon(new Unicode11Addon())
  terminal.unicode.activeVersion = '11'
  const write = (data) => terminal._core.writeSync(data)
  if (alternate) {
    write('\x1b[?1049h')
  }
  write('warm\r\x1b[2K')
  for (let index = 0; index < 3; index++) {
    global.gc()
  }
  const baseline = process.memoryUsage().heapUsed
  const chunk = '\u0301'.repeat(1000)
  for (let row = 0; row < (scenario === 'live' || scenario === 'scratch' ? 1 : rows); row++) {
    write(`\x1b[${row + 1};${scenario === 'scratch' ? 12 : 1}Ha`)
    for (let index = 0; index < marks / chunk.length; index++) {
      write(chunk)
    }
    if (scenario === 'cache') {
      terminal._core.buffer.lines.get(row).translateToString(true)
    }
    if (scenario === 'overwrite') {
      write('\rZ')
    }
    if (scenario === 'erase') {
      write('\r\x1b[2K')
    }
  }
  if (scenario === 'cache') {
    write('\x1b[2J')
  }
  if (scenario === 'scratch') {
    write('\r\x1b[P\x1b[2J')
  }
  for (let index = 0; index < 3; index++) {
    global.gc()
  }
  const heapGrowth = process.memoryUsage().heapUsed - baseline
  let visibleChars = 0
  let staleCombinedChars = 0
  let invalidCacheChars = 0
  for (let row = 0; row < terminal._core.buffer.lines.length; row++) {
    const line = terminal._core.buffer.lines.get(row)
    for (let col = 0; col < line.length; col++) {
      visibleChars += line.getString(col).length
    }
    for (const [key, value] of Object.entries(line._combined)) {
      if (!line.isCombined(Number(key))) {
        staleCombinedChars += value.length
      }
    }
    if (!line._cacheValid) {
      invalidCacheChars += line._cache.length
    }
  }
  const result = {
    scenario,
    alternate,
    heapGrowth,
    visibleChars,
    staleCombinedChars,
    invalidCacheChars
  }
  terminal.dispose()
  return result
}

if (process.argv[2] === '--case') {
  console.log(
    JSON.stringify(await measure(process.argv[3], process.argv[4], process.argv[5] === 'true'))
  )
} else {
  const installed = resolve('node_modules/@xterm/headless/lib-headless/xterm-headless.js')
  const desktop = resolve('node_modules/@xterm/xterm/lib/xterm.js')
  const mobile = resolve('mobile/node_modules/@xterm/xterm/lib/xterm.js')
  const bundles = [
    ...(process.env.ORCA_AUDIT_HEADLESS_BASELINE
      ? [['before', resolve(process.env.ORCA_AUDIT_HEADLESS_BASELINE)]]
      : []),
    ['headless-cjs', installed],
    ['headless-esm', installed.replace(/\.js$/, '.mjs')],
    ['desktop-cjs', desktop],
    ['desktop-esm', desktop.replace(/\.js$/, '.mjs')],
    ['mobile-cjs', mobile],
    ['mobile-esm', mobile.replace(/\.js$/, '.mjs')]
  ]
  const results = []
  for (const [phase, bundle] of bundles) {
    const sha256 = createHash('sha256').update(readFileSync(bundle)).digest('hex')
    const samples = []
    for (const scenario of cases) {
      for (const alternate of [false, true]) {
        samples.push(
          JSON.parse(
            execFileSync(
              process.execPath,
              ['--expose-gc', ownPath, '--case', bundle, scenario, String(alternate)],
              { encoding: 'utf8' }
            )
          )
        )
      }
    }
    results.push({ phase, sha256, samples })
  }
  const fixed = results
    .filter(({ phase }) => phase !== 'before')
    .every(({ samples }) =>
      samples.every((sample) =>
        sample.scenario === 'live'
          ? sample.visibleChars === marks + 1
          : sample.staleCombinedChars === 0 &&
            sample.invalidCacheChars === 0 &&
            sample.heapGrowth < 1024 * 1024
      )
    )
  console.log(JSON.stringify({ marks, rows, fixed, results }, null, 2))
  if (!fixed) {
    process.exitCode = 1
  }
}
