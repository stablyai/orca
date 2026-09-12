// Runs the real relay bundle under --expose-gc and reports post-collection memory on SIGUSR2.
// Nothing about the relay changes: this only adds a signal handler before loading it.
//
// If ORCA_HEAP_SNAPSHOT_REQUEST names a file and that file exists when the signal arrives, its
// contents are read as a destination path and a heap snapshot is written there after the
// collection. The request file is consumed, so one request yields one snapshot.
const { writeFileSync, readFileSync, existsSync, unlinkSync } = require('node:fs')

const report = process.env.ORCA_GC_REPORT
const snapshotRequest = process.env.ORCA_HEAP_SNAPSHOT_REQUEST

process.on('SIGUSR2', () => {
  try {
    // Twice: the first pass can resurrect via finalizers, the second settles it.
    global.gc()
    global.gc()
  } catch {
    /* --expose-gc absent; report raw numbers so the caller can tell */
  }
  let snapshot = null
  try {
    if (snapshotRequest && existsSync(snapshotRequest)) {
      const dest = readFileSync(snapshotRequest, 'utf8').trim()
      unlinkSync(snapshotRequest)
      if (dest) {
        require('node:v8').writeHeapSnapshot(dest)
        snapshot = dest
      }
    }
  } catch {
    /* a failed snapshot must not stop the memory report */
  }
  try {
    // Written last: the caller polls for this, so it must not appear before the snapshot is done.
    writeFileSync(report, JSON.stringify({ at: Date.now(), mem: process.memoryUsage(), snapshot }))
  } catch {
    /* best-effort */
  }
})

require('./relay.js')
