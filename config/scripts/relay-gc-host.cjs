// Runs the real relay bundle under --expose-gc and reports post-collection memory on SIGUSR2.
// Nothing about the relay changes: this only adds a signal handler before loading it.
const { writeFileSync } = require('node:fs')

const report = process.env.ORCA_GC_REPORT
process.on('SIGUSR2', () => {
  try {
    // Twice: the first pass can resurrect via finalizers, the second settles it.
    global.gc()
    global.gc()
  } catch {
    /* --expose-gc absent; report raw numbers so the caller can tell */
  }
  try {
    writeFileSync(report, JSON.stringify({ at: Date.now(), mem: process.memoryUsage() }))
  } catch {
    /* best-effort */
  }
})

require('./relay.js')
