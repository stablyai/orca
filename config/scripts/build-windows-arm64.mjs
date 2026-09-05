#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { forwardSynchronousChildFailure } from './synchronous-child-process-result.mjs'

if (process.platform !== 'win32') {
  throw new Error('The Windows ARM64 package must be built on a Windows host.')
}

const electronBuilderCli = resolve('node_modules', 'electron-builder', 'cli.js')
const result = spawnSync(
  process.execPath,
  [
    electronBuilderCli,
    '--config',
    'config/electron-builder.config.cjs',
    '--win',
    '--arm64',
    '--publish',
    'never'
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      // Why: the packaging config must omit x64-only native speech resources
      // and give the local artifact an architecture-specific name.
      ORCA_WINDOWS_ARM64_BUILD: '1'
    }
  }
)

forwardSynchronousChildFailure(result)
