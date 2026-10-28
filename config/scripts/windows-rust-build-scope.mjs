#!/usr/bin/env node
// Prints `toolchain=` and `app-version=` cache-key outputs for the Windows Rust executables.
// rustc goes in restore-key prefixes because the exe reuse fingerprint does not cover it.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed: ${result.error?.message ?? result.status}`
    )
  }
  return result.stdout
}

const root = resolve(import.meta.dirname, '../..')
if (spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status !== 0) {
  run('rustup', ['toolchain', 'install', 'stable', '--profile', 'minimal'])
  run('rustup', ['default', 'stable'])
}
const rustc = /^rustc (\S+)/.exec(run('rustc', ['--version']))?.[1]
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
if (!rustc || !version) {
  throw new Error('Missing rustc or package.json version')
}
console.log(`toolchain=rustc${rustc}`)
console.log(`app-version=${version}`)
