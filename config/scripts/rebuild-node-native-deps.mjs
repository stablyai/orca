#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const modules = ['better-sqlite3', 'node-pty', '@parcel/watcher']

const getPnpmCommand = () => {
  const corepackRoot = process.env.COREPACK_ROOT
  const corepackEntry = corepackRoot ? join(corepackRoot, 'dist/corepack.js') : undefined

  if (corepackEntry && existsSync(corepackEntry)) {
    return {
      command: process.execPath,
      args: [corepackEntry, 'pnpm']
    }
  }

  if (process.env.npm_execpath?.includes('pnpm') && existsSync(process.env.npm_execpath)) {
    return {
      command: process.execPath,
      args: [process.env.npm_execpath]
    }
  }

  return {
    command: 'pnpm',
    args: []
  }
}

try {
  const pnpm = getPnpmCommand()
  execFileSync(pnpm.command, [...pnpm.args, 'rebuild', ...modules], {
    stdio: 'inherit'
  })
} catch (error) {
  console.error('[rebuild] Failed to rebuild native modules for Node.js:', error.message)
  process.exit(1)
}
