import { appendFileSync } from 'node:fs'

// Action-state and output plumbing via the runner's file protocol, so the action needs no
// @actions/core dependency. Values are single-line by construction; anything else is rejected.

/** The detached renewer's stdio is ignored, so it appends here instead and `post` echoes it. */
export function renewerLogPath() {
  const dir = process.env.RUNNER_TEMP
  return dir ? `${dir}/cloud-sql-rollout-lease-renewer.log` : null
}

export function input(name) {
  return (process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim()
}

export function savedState(name) {
  return (process.env[`STATE_${name}`] ?? '').trim()
}

export function saveState(name, value) {
  appendToEnvFile('GITHUB_STATE', name, value)
}

export function setOutput(name, value) {
  appendToEnvFile('GITHUB_OUTPUT', name, value)
}

export function notice(message) {
  console.log(`::notice::${oneLine(message)}`)
}

export function warn(message) {
  console.log(`::warning::${oneLine(message)}`)
}

export function fail(message) {
  console.log(`::error::${oneLine(message)}`)
  process.exitCode = 1
}

function appendToEnvFile(variable, name, value) {
  const text = String(value)
  if (/[\r\n]/.test(text)) {
    throw new Error(`${name} must be single-line`)
  }
  const path = process.env[variable]
  if (!path) {
    return
  } // Running outside a runner (local smoke run); nothing to persist.
  appendFileSync(path, `${name}=${text}\n`)
}

function oneLine(message) {
  return String(message).replace(/\r?\n/g, ' ')
}
