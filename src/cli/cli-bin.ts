#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { launchBunCli } from './runtime/cli-bun-launcher'
import { resolveBundledCliRuntimePath } from '../shared/bundled-cli-runtime-path'

try {
  const entry = realpathSync(process.argv[1])
  launchBunCli(
    resolveBundledCliRuntimePath(entry),
    join(dirname(entry), 'index.js'),
    process.argv.slice(2)
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 78
}
