#!/usr/bin/env node
'use strict'

const MIN_NODE_MAJOR = 22
const nodeMajor = Number(process.versions.node.split('.')[0])
// Why: the floor is a support policy, not a hard requirement; older Node gets a warning only.
if (!(nodeMajor >= MIN_NODE_MAJOR)) {
  process.stderr.write(
    `orca: Node ${process.versions.node} is not supported; the standalone Orca CLI needs Node ${MIN_NODE_MAJOR} or newer. Continuing anyway.\n`
  )
}

const nodeModule = require('node:module')
if (typeof nodeModule.enableCompileCache === 'function') {
  try {
    nodeModule.enableCompileCache()
  } catch {
    // Why: the cache only speeds up startup; an unwritable cache dir must not block the CLI.
  }
}

require('../orca.cjs').main()
