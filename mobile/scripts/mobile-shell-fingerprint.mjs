#!/usr/bin/env node
// Answers "does this change need a mobile store release?" by fingerprinting the shell: the native
// project inputs plus the JS bundle each shell variant embeds. See
// docs/reference/mobile-shell-fingerprint.md.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import {
  compareShellFingerprints,
  FINGERPRINT_FORMAT,
  PLATFORMS,
  renderShellVerdictMarkdown,
  VARIANTS
} from './mobile-shell-fingerprint-compare.mjs'
import { exportShellBundle } from './mobile-shell-fingerprint-export.mjs'
import { computeNativeFingerprint } from './mobile-shell-fingerprint-native.mjs'

const USAGE = `usage:
  mobile-shell-fingerprint.mjs compute [--project <mobile dir>] --out <file.json>
  mobile-shell-fingerprint.mjs compare <base.json> <head.json> [--since <tag>] [--json]`

function option(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? null : args[index + 1]
}

function compute(args) {
  const projectDir = path.resolve(option(args, '--project') ?? path.join(import.meta.dirname, '..'))
  const out = option(args, '--out')
  if (!out) {
    throw new Error(USAGE)
  }
  const native = {}
  for (const platform of PLATFORMS) {
    native[platform] = computeNativeFingerprint(projectDir, platform)
  }
  const shellJs = {}
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-shell-fingerprint-'))
  try {
    for (const variant of VARIANTS) {
      shellJs[variant] = {}
      for (const platform of PLATFORMS) {
        const outputDir = path.join(scratch, `${variant}-${platform}`)
        shellJs[variant][platform] = exportShellBundle(projectDir, variant, platform, outputDir)
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
  fs.writeFileSync(out, `${JSON.stringify({ format: FINGERPRINT_FORMAT, native, shellJs })}\n`)
  const hashes = [
    ...PLATFORMS.map((platform) => `native/${platform} ${native[platform].hash}`),
    ...VARIANTS.flatMap((variant) =>
      PLATFORMS.map(
        (platform) => `shellJs/${variant}/${platform} ${shellJs[variant][platform].hash}`
      )
    )
  ]
  process.stderr.write(`${hashes.join('\n')}\n`)
}

function readRecord(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// Always exits 0: the verdict is data, and an unreadable record is an "unknown" verdict.
function compare(args) {
  const [baseFile, headFile] = args
  if (!baseFile || !headFile) {
    throw new Error(USAGE)
  }
  const verdict = compareShellFingerprints(readRecord(baseFile), readRecord(headFile))
  process.stdout.write(
    args.includes('--json')
      ? `${JSON.stringify(verdict)}\n`
      : renderShellVerdictMarkdown(verdict, option(args, '--since') ?? '')
  )
}

const [command, ...args] = process.argv.slice(2)
if (command === 'compute') {
  compute(args)
} else if (command === 'compare') {
  compare(args)
} else {
  process.stderr.write(`${USAGE}\n`)
  process.exitCode = 2
}
