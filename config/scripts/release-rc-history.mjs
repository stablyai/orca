#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

function gitLines(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

export function rcNumberFromTag(base, tag) {
  const prefix = `v${base}-rc.`
  if (!tag.startsWith(prefix)) {
    return null
  }

  const suffix = tag.slice(prefix.length)
  return /^\d+$/.test(suffix) ? Number(suffix) : null
}

export function rcNumberFromReleaseSubject(base, subject) {
  const prefix = `release: v${base}-rc.`
  if (!subject.startsWith(prefix)) {
    return null
  }

  const match = /^(\d+)(?:\s|$)/.exec(subject.slice(prefix.length))
  return match ? Number(match[1]) : null
}

export function highestRcForBase(base, { cwd = process.cwd() } = {}) {
  const numbers = []

  for (const tag of gitLines(['tag', '--list', `v${base}-rc.*`], cwd)) {
    const rcNumber = rcNumberFromTag(base, tag)
    if (rcNumber !== null) {
      numbers.push(rcNumber)
    }
  }

  const logRefs = ['HEAD', 'origin/main'].filter(
    (ref) => gitLines(['rev-parse', '--verify', '--quiet', ref], cwd).length > 0
  )
  if (logRefs.length > 0) {
    for (const subject of gitLines(['log', '--format=%s', ...logRefs], cwd)) {
      const rcNumber = rcNumberFromReleaseSubject(base, subject)
      if (rcNumber !== null) {
        numbers.push(rcNumber)
      }
    }
  }

  return numbers.length === 0 ? null : Math.max(...numbers)
}

function main() {
  const base = process.argv[2]
  if (!base) {
    throw new Error('Usage: node config/scripts/release-rc-history.mjs <base-version>')
  }

  const highest = highestRcForBase(base)
  if (highest !== null) {
    process.stdout.write(String(highest))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
