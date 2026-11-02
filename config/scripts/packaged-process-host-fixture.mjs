import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'

const require = createRequire(import.meta.url)
const requireFromBuilder = createRequire(require.resolve('electron-builder/package.json'))
const { copyFiles, FileMatcher } = requireFromBuilder('app-builder-lib/out/fileMatcher')
const { createPackagedRuntimeNodeModuleResources } = require('../packaged-runtime-node-modules.cjs')

export async function stagePackagedProcessHost(resourcesDir) {
  const resource = createPackagedRuntimeNodeModuleResources().find(
    (entry) => entry.to === join('node_modules', '@orca', 'process-host')
  )
  if (!resource) {
    throw new Error('Packaged process-host resource is missing')
  }
  const packageDir = join(resourcesDir, resource.to)
  await copyFiles([new FileMatcher(resource.from, packageDir, (value) => value, resource.filter)])
  return packageDir
}

/** Writes an unpacked-CLI consumer that checks require/import identity, shared state, and subprocesses. */
export async function writePackagedProcessHostConsumer(resourcesDir) {
  const outDir = join(resourcesDir, 'app.asar.unpacked', 'out')
  const cliDir = join(outDir, 'cli')
  await mkdir(cliDir, { recursive: true })
  await writeFile(join(outDir, 'package.json'), '{"type":"commonjs"}\n', 'utf8')
  const entry = join(cliDir, 'index.js')
  await writeFile(
    entry,
    [
      "const assert = require('node:assert/strict')",
      "const { once } = require('node:events')",
      "const { runProcessSync, runProcess, spawnProcess } = require('@orca/process-host')",
      "const { setSpawnObserver } = require('@orca/process-host/spawn-observer')",
      "const { setProcessTreeKillGate } = require('@orca/process-host/process-tree-kill-gate')",
      "const { signalProcessTree } = require('@orca/process-host/process-tree-termination')",
      "import('@orca/process-host').then(async ({ runProcessSync: esmRunProcessSync }) => {",
      'assert.equal(runProcessSync, esmRunProcessSync)',
      'const result = runProcessSync({',
      '  program: process.execPath,',
      "  args: ['-e', 'process.stdout.write(\"copied-runtime\")']",
      '})',
      'assert.equal(result.code, 0)',
      'const observedCommands = []',
      'const gateCalls = []',
      'setSpawnObserver((command) => observedCommands.push(command))',
      'let child, closed, watchdog',
      'try {',
      'const observed = await runProcess({',
      '  program: process.execPath,',
      "  args: ['-e', 'process.stdout.write(\"observed-spawn\")']",
      '})',
      'assert.equal(observed.code, 0)',
      'assert.equal(observed.stdout, "observed-spawn")',
      'assert.deepEqual(observedCommands, [process.execPath])',
      'child = spawnProcess({',
      '  program: process.execPath,',
      "  args: ['-e', 'setInterval(() => {}, 1000)'],",
      '  detached: true',
      '})',
      'closed = once(child, "close")',
      'watchdog = setTimeout(() => child.kill("SIGKILL"), 5000)',
      'const rootSignals = []',
      'const killRoot = child.kill.bind(child)',
      'child.kill = (signal) => { rootSignals.push(signal); return killRoot(signal) }',
      'setProcessTreeKillGate((request) => { gateCalls.push(request); return false })',
      'const verified = await signalProcessTree(child, "SIGTERM")',
      'await closed',
      'assert.equal(verified, false)',
      'assert.equal(gateCalls.length, 1)',
      'assert.equal(gateCalls[0].pid, child.pid)',
      'assert.equal(gateCalls[0].scope, process.platform === "win32" ? "win-taskkill-tree" : "posix-process-group")',
      'assert.deepEqual(rootSignals, ["SIGTERM"])',
      'assert.deepEqual(observedCommands, [process.execPath, process.execPath])',
      '} finally {',
      'clearTimeout(watchdog)',
      'setSpawnObserver(null)',
      'setProcessTreeKillGate(null)',
      'if (child && child.exitCode === null && child.signalCode === null) {',
      '  child.kill("SIGKILL")',
      '  await closed',
      '}',
      '}',
      'process.stdout.write(result.stdout)',
      '}).catch((error) => { console.error(error); process.exitCode = 1 })'
    ].join('\n'),
    'utf8'
  )
  return { outDir, entry }
}

export function runPackagedProcessHostConsumer(nodeExecutable, resourcesDir, entry) {
  return runProcessSync({
    program: nodeExecutable,
    args: [entry],
    cwd: resourcesDir,
    timeoutMs: 15_000,
    env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', ORCA_BACKGROUND_LAUNCH: '1' }
  })
}
