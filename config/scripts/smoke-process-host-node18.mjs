#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  runPackagedProcessHostConsumer,
  stagePackagedProcessHost,
  writePackagedProcessHostConsumer
} from './packaged-process-host-fixture.mjs'

// Qualifies the package's engines floor against the staged public output, not the checkout source.
assert.match(process.versions.node, /^18\./, 'This smoke test must run under Node 18')

const resourcesDir = await mkdtemp(join(tmpdir(), 'orca-process-host-node18-'))
try {
  await stagePackagedProcessHost(resourcesDir)
  const { entry } = await writePackagedProcessHostConsumer(resourcesDir)
  const result = runPackagedProcessHostConsumer(process.execPath, resourcesDir, entry)
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, 'copied-runtime')
} finally {
  await rm(resourcesDir, { recursive: true, force: true })
}

console.log(`Node ${process.versions.node} process-host package smoke passed.`)
