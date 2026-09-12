#!/usr/bin/env node

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { orcadBunRuntimeFilename } from '../../src/shared/orcad-artifacts.ts'
import { runProcessSync, spawnProcess } from './script-child-process.mjs'

const root = resolve(import.meta.dirname, '../..')
const artifactArgument = process.argv.indexOf('--artifact-dir')
if (artifactArgument !== -1 && !process.argv[artifactArgument + 1]) {
  throw new Error('--artifact-dir requires a directory')
}
const sourceArtifact =
  artifactArgument === -1 ? join(root, 'out', 'orcad') : resolve(process.argv[artifactArgument + 1])
const temporary = mkdtempSync(join(tmpdir(), 'orcad-bun-isolated-'))
const artifact = join(temporary, 'artifact')

function verifyWatcher() {
  const watched = join(temporary, 'watched')
  mkdirSync(watched)
  const child = spawnProcess({
    program: join(artifact, orcadBunRuntimeFilename(process.platform)),
    args: [join(artifact, 'parcel-watcher-process-entry.js')],
    cwd: temporary,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  })
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const finish = (error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (child.exitCode === null) {
        child.kill('SIGTERM')
      }
      if (error) {
        rejectPromise(error)
      } else {
        resolvePromise()
      }
    }
    const timer = setTimeout(
      () => finish(new Error(`isolated watcher produced no event:\n${stderr.slice(0, 2000)}`)),
      15_000
    )
    child.on('error', finish)
    child.on('exit', (code) => {
      if (!settled) {
        finish(new Error(`isolated watcher exited with ${code}:\n${stderr.slice(0, 2000)}`))
      }
    })
    child.on('message', (message) => {
      if (message?.op === 'subscribed' && message.id === 1) {
        writeFileSync(join(watched, 'marker.txt'), 'ok')
        return
      }
      if (message?.op === 'events' && message.id === 1) {
        if (message.events.some((event) => event.path.endsWith('marker.txt'))) {
          finish()
        }
        return
      }
      if (message?.op === 'subscribe-failed' || message?.op === 'watch-error') {
        finish(new Error(`isolated watcher failed: ${message.message}`))
      }
    })
    child.send({ op: 'subscribe', id: 1, dir: watched, opts: {} })
  })
}

try {
  cpSync(sourceArtifact, artifact, { recursive: true })
  await verifyWatcher()
  process.stdout.write('[orcad-bun-isolated] watcher event delivery OK\n')
  const result = runProcessSync({
    program: process.execPath,
    args: [
      join(root, 'config', 'scripts', 'runtime-serve-terminal-smoke.mjs'),
      '--target',
      'orcad',
      '--runtime',
      'bundled-bun'
    ],
    cwd: temporary,
    env: { ...process.env, ORCA_SMOKE_ORCAD_ENTRY: join(artifact, 'orcad.js') },
    stdio: 'inherit',
    timeoutMs: null
  })
  if (result.code !== 0) {
    process.exitCode = result.code ?? 1
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
