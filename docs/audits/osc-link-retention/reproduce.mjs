import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import headless from '@xterm/headless'
import rendered from '@xterm/xterm'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1' || typeof global.gc !== 'function') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1 node --expose-gc')
}
const root = fileURLToPath(new URL('../../../', import.meta.url))
const built = await build({
  entryPoints: [resolve(root, 'src/shared/terminal-osc-link-retirement.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false
})
const bundle = built.outputFiles[0].text
const { createTerminalOscLinkRetirement } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`
)
const results = []
for (const [kind, { Terminal }] of [
  ['headless', headless],
  ['renderer', rendered]
]) {
  for (const mode of ['overwrite', 'erase-line', 'alternate', 'alternate-toggle']) {
    for (const fixed of [false, true]) {
      const terminal = new Terminal({
        cols: 80,
        rows: 24,
        scrollback: 5000,
        allowProposedApi: true,
        logLevel: 'off'
      })
      const retirement = createTerminalOscLinkRetirement(terminal)
      const core = terminal._core
      if (mode === 'alternate') {
        core.writeSync('\x1b[?1049h')
      }
      global.gc()
      const before = process.memoryUsage().heapUsed
      const samples = []
      try {
        for (let index = 1; index <= 10000; index++) {
          core.writeSync(
            `${mode === 'erase-line' ? '\x1b[2K' : ''}\r\x1b]8;;https://example.test/path\x1b\\x\x1b]8;;\x1b\\`
          )
          if (fixed) {
            retirement()
          }
          if (mode === 'alternate-toggle') {
            core.writeSync('\x1b[?1049h\x1b]8;;https://example.test/alt\x1b\\x\x1b]8;;\x1b\\')
            if (fixed) {
              retirement()
            }
            core.writeSync('\x1b[?1049l')
            if (fixed) {
              retirement()
            }
          }
          if (index % 2500 === 0) {
            global.gc()
            samples.push({
              updates: index,
              links: core._oscLinkService._dataByLinkId.size,
              markers: terminal.markers.length,
              rows: terminal.buffer.active.length,
              retainedHeapDelta: process.memoryUsage().heapUsed - before
            })
          }
        }
        results.push({ kind, mode, fixed, samples })
      } finally {
        terminal.dispose()
      }
    }
  }
}
const sweepCosts = []
for (const scrollback of [5000, 50000]) {
  for (const density of ['plain', 'linked']) {
    const terminal = new headless.Terminal({
      cols: 160,
      rows: 24,
      scrollback,
      allowProposedApi: true,
      logLevel: 'off'
    })
    try {
      const text = 'x'.repeat(160)
      for (let row = 0; row < scrollback + 24; row++) {
        const output =
          density === 'plain'
            ? text
            : `\x1b]8;;https://example.test/kept-${row}\x1b\\${text}\x1b]8;;\x1b\\`
        terminal._core.writeSync(`${output}\r\n`)
      }
      const retirement = createTerminalOscLinkRetirement(terminal)
      const milliseconds = []
      let removed = 0
      for (let sample = 0; sample < 5; sample++) {
        terminal._core.writeSync(
          '\r\x1b]8;;https://example.test/path\x1b\\x\x1b]8;;\x1b\\'.repeat(1024)
        )
        const started = performance.now()
        removed = retirement()
        milliseconds.push(performance.now() - started)
      }
      sweepCosts.push({
        rows: terminal.buffer.normal.length,
        columns: terminal.cols,
        density,
        removed,
        milliseconds
      })
    } finally {
      terminal.dispose()
    }
    global.gc()
  }
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      bundleSha256: createHash('sha256').update(bundle).digest('hex'),
      results,
      sourceSha256: createHash('sha256')
        .update(readFileSync(resolve(root, 'src/shared/terminal-osc-link-retirement.ts')))
        .digest('hex'),
      scriptSha256: createHash('sha256')
        .update(readFileSync(import.meta.filename))
        .digest('hex'),
      runtimeSha256: Object.fromEntries(
        [
          ['headless', 'node_modules/@xterm/headless/lib-headless/xterm-headless.js'],
          ['renderer', 'node_modules/@xterm/xterm/lib/xterm.js']
        ].map(([name, file]) => [
          name,
          createHash('sha256')
            .update(readFileSync(resolve(root, file)))
            .digest('hex')
        ])
      ),
      sweepCosts
    },
    null,
    2
  )
)
