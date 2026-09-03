#!/usr/bin/env node

import { chmodSync, lstatSync, mkdirSync, readlinkSync, statSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const scriptPath = import.meta.filename
const scriptDir = import.meta.dirname
const defaultSource = path.join(scriptDir, 'orca-sub.mjs')

export function installSubCli({
  source = defaultSource,
  installDir = path.join(homedir(), '.local', 'bin')
} = {}) {
  if (process.platform === 'win32') {
    return { status: 'skipped', commandPath: null }
  }

  const commandPath = path.join(installDir, 'orca-sub')
  makeExecutable(source)
  mkdirSync(installDir, { recursive: true })

  const existing = readExistingEntry(commandPath)
  if (existing) {
    if (existing.kind === 'symlink' && sameSymlinkTarget(commandPath, existing.target, source)) {
      return { status: 'already-installed', commandPath }
    }
    return { status: 'conflict', commandPath }
  }

  symlinkSync(source, commandPath)
  return { status: 'installed', commandPath }
}

function makeExecutable(source) {
  const mode = statSync(source).mode
  if ((mode & 0o111) === 0) {
    chmodSync(source, mode | 0o111)
  }
}

function readExistingEntry(commandPath) {
  try {
    const stats = lstatSync(commandPath)
    return stats.isSymbolicLink()
      ? { kind: 'symlink', target: readlinkSync(commandPath) }
      : { kind: 'other' }
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function sameSymlinkTarget(commandPath, target, source) {
  return path.resolve(path.dirname(commandPath), target) === path.resolve(source)
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  const result = installSubCli()
  if (result.status === 'installed') {
    console.log(`[orca-sub] Installed ${result.commandPath} → ${defaultSource}`)
  } else if (result.status === 'already-installed') {
    console.log(`[orca-sub] ${result.commandPath} already points to the local subagent CLI.`)
  } else if (result.status === 'conflict') {
    console.warn(
      `[orca-sub] ${result.commandPath} already exists and is not this checkout's subagent CLI; left unchanged.`
    )
  }
}
