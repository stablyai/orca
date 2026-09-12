#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { resolvePnpmCliInvocation } from './pnpm-cli-invocation.mjs'

if (process.platform === 'win32') {
  runNodeScript('config/scripts/build-windows-cli-launcher.mjs')
  process.exit(0)
}

if (process.platform !== 'darwin') {
  console.log(`[native-build] no macOS native computer build required on ${process.platform}`)
  process.exit(0)
}

// Each compiler tree needs its own group so cancellation reaches Swift descendants.
const children = new Map()
let externalSignal = null
let stopping = false
let outputFailed = false
let forceTimer
const signalHandlers = new Map()

process.on('SIGINT', handlerFor('SIGINT'))
process.on('SIGTERM', handlerFor('SIGTERM'))
for (const target of [process.stdout, process.stderr]) {
  target.on('error', () => {
    outputFailed = true
    process.exitCode = 1
    stopBuilds()
  })
}

const exitCodes = await Promise.all(
  ['build:computer-macos', 'build:keyboard-layout-macos', 'build:notification-status-macos'].map(
    (scriptName) => runPnpmScript(scriptName)
  )
)
clearTimeout(forceTimer)
for (const [signal, handler] of signalHandlers) {
  process.removeListener(signal, handler)
}
if (externalSignal) {
  process.kill(process.pid, externalSignal)
} else {
  process.exitCode = Math.max(outputFailed ? 1 : 0, ...exitCodes)
}

function handlerFor(signal) {
  if (!signalHandlers.has(signal)) {
    signalHandlers.set(signal, () => {
      externalSignal ??= signal
      stopBuilds(signal)
    })
  }
  return signalHandlers.get(signal)
}

function stopBuilds(signal = 'SIGTERM') {
  if (stopping) {
    return
  }
  stopping = true
  terminateAll(signal)
  if (children.size > 0) {
    forceTimer ??= setTimeout(() => terminateAll('SIGKILL'), 2_000)
  }
}

function terminateAll(signal) {
  for (const [child, label] of children) {
    if (!child.pid) {
      continue
    }
    console.log(`[native-build] stopping ${label} (${signal})`)
    try {
      process.kill(-child.pid, signal)
    } catch {
      // group already gone
      try {
        child.kill(signal)
      } catch {}
    }
  }
}

function runPnpmScript(scriptName) {
  if (stopping) {
    return Promise.resolve(1)
  }
  const label = scriptName.replace(/^build:|-macos$/g, '')
  const { command, prefixArgs, shell } = resolvePnpmCliInvocation()
  const child = spawn(command, [...prefixArgs, 'run', scriptName], {
    detached: true,
    shell,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.set(child, scriptName)
  pipePrefixed(child.stdout, label, process.stdout)
  pipePrefixed(child.stderr, label, process.stderr)

  return new Promise((resolve) => {
    let failed = false
    child.on('error', (error) => {
      failed = true
      console.error(`[${label}] ${error.message}`)
      stopBuilds()
    })
    child.on('exit', (code, signal) => {
      if (code !== 0 || signal) {
        stopBuilds()
      }
    })
    // Re-raise the parent's signal only after every child and its output pipes close.
    child.on('close', (code, signal) => {
      children.delete(child)
      resolve(failed || signal ? 1 : (code ?? 1))
    })
  })
}

function pipePrefixed(stream, label, target) {
  stream.setEncoding('utf8')
  let buffer = ''
  stream.on('data', (chunk) => {
    if (target.destroyed) {
      return
    }
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      target.write(`[${label}] ${line}\n`)
    }
  })
  stream.on('end', () => {
    if (buffer.length > 0 && !target.destroyed) {
      target.write(`[${label}] ${buffer}\n`)
    }
  })
}

function runNodeScript(scriptPath) {
  const result = spawnSync(process.execPath, [scriptPath], { stdio: 'inherit' })
  if (result.signal) {
    process.kill(process.pid, result.signal)
  }
  if (result.status !== 0 || result.error) {
    process.exit(result.status ?? 1)
  }
}
