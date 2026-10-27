#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const scriptDir = dirname(scriptPath)
const runtimeDir = join(scriptDir, 'test-cost')

function invoke(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  return result.status ?? 1
}

export function executionPlan(argv, platform = process.platform, cwd = process.cwd()) {
  const args = [...argv]
  const nativeArg = args[0]?.startsWith('--native-runtime=') ? args.shift() : null
  if (nativeArg && !['--native-runtime=node', '--native-runtime=electron'].includes(nativeArg)) {
    throw new Error('native runtime must be node or electron')
  }
  const runner = args[0]
  if (!['vitest', 'jest', 'playwright'].includes(runner)) {
    throw new Error('usage: test-cost-entry.mjs [--native-runtime=node|electron] vitest|jest|playwright ...')
  }
  const before = nativeArg
    ? [process.execPath, join(scriptDir, 'ensure-native-runtime.mjs'), nativeArg.replace('--native-', '--')]
    : null
  if (platform !== 'win32') {
    const prefix = before
      ? ['--shell-launcher-json', JSON.stringify([process.execPath, scriptPath, '--execute-selected', nativeArg])]
      : []
    return { command: 'python3', args: [join(runtimeDir, 'affected_tests.py'), ...prefix, '--', ...args], before: null }
  }
  // Native Windows retains the installed CLI without requiring POSIX sh/fcntl.
  const require = createRequire(join(cwd, 'package.json'))
  const candidates = runner === 'playwright' ? ['@playwright/test', 'playwright'] : [runner]
  for (const name of candidates) {
    try {
      const manifestPath = require.resolve(`${name}/package.json`)
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[runner]
      if (bin) return { command: process.execPath, args: [resolve(dirname(manifestPath), bin), ...args.slice(1)], before }
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error
    }
  }
  throw new Error(`installed ${runner} CLI not found; install this package's dependencies first`)
}

export function main(argv) {
  if (argv[0] === '--execute-selected') {
    if (process.platform === 'win32' || !['--native-runtime=node', '--native-runtime=electron'].includes(argv[1]) || argv.length !== 3) {
      throw new Error('invalid selected-runner invocation')
    }
    if (invoke('sh', [join(runtimeDir, 'test_gate.sh'), 'check-held']) !== 0) {
      throw new Error('selected-runner invocation requires a verified gate owner')
    }
    const prepared = invoke(process.execPath, [join(scriptDir, 'ensure-native-runtime.mjs'), argv[1].replace('--native-', '--')])
    return prepared || invoke('sh', ['-c', argv[2]])
  }
  const plan = executionPlan(argv)
  if (plan.before) {
    const prepared = invoke(plan.before[0], plan.before.slice(1))
    if (prepared) return prepared
  }
  return invoke(plan.command, plan.args)
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(scriptPath)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(`test-cost: ${error.message}`)
    process.exitCode = 2
  }
}
