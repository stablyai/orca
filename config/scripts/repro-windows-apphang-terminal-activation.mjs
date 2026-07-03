#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  createWslFixture,
  listWslDistros,
  removeWslFixture
} from './windows-apphang-repro/wsl-workspace-fixture.mjs'
import { runGpuMode } from './windows-apphang-repro/terminal-activation-scenario.mjs'
import { summarizeResult } from './windows-apphang-repro/apphang-report-summary.mjs'

const defaultCycles = 14
const defaultOutputLines = 1_600

function parseArgs() {
  const args = {
    cycles: defaultCycles,
    distro: null,
    expect: 'none',
    gpuModes: ['on'],
    keep: false,
    outputLines: defaultOutputLines,
    reportPath: null,
    sourceControl: true,
    deadPtyReactivate: true
  }

  for (const arg of process.argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
    if (arg === '--keep') {
      args.keep = true
      continue
    }
    if (arg === '--no-source-control') {
      args.sourceControl = false
      continue
    }
    if (arg === '--no-dead-pty-reactivate') {
      args.deadPtyReactivate = false
      continue
    }
    const [name, value] = arg.split('=', 2)
    if (name === '--cycles') {
      args.cycles = parsePositiveInt(name, value)
      continue
    }
    if (name === '--distro') {
      args.distro = value?.trim() || null
      continue
    }
    if (name === '--expect') {
      if (!['none', 'repro', 'pass'].includes(value)) {
        throw new Error(`Unsupported --expect=${value}. Use none, repro, or pass.`)
      }
      args.expect = value
      continue
    }
    if (name === '--gpu') {
      const modes = (value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
      if (modes.length === 0 || modes.some((mode) => !['on', 'off', 'auto'].includes(mode))) {
        throw new Error(`Unsupported --gpu=${value}. Use on, off, auto, or a comma-list.`)
      }
      args.gpuModes = modes
      continue
    }
    if (name === '--output-lines') {
      args.outputLines = parsePositiveInt(name, value)
      continue
    }
    if (name === '--report') {
      args.reportPath = value?.trim() || null
      if (!args.reportPath) {
        throw new Error('--report requires a file path.')
      }
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  return args
}

function printHelp() {
  console.log(`Usage:
  node config/scripts/repro-windows-apphang-terminal-activation.mjs [options]

Options:
  --expect=none|repro|pass       none prints measurements, repro exits 0 only when hang evidence is observed,
                                 pass exits 1 if hang evidence is observed. Default: none.
  --gpu=on|off|auto[,mode...]    Terminal GPU setting(s) to run. Default: on.
  --cycles=N                     Activation/output cycles per GPU mode. Default: ${defaultCycles}.
  --output-lines=N               Lines emitted by each terminal stress command. Default: ${defaultOutputLines}.
  --report=PATH                  Write full JSON evidence to PATH and print a compact summary to stdout.
  --distro=NAME                  WSL distro to use. Default: first non docker-desktop distro.
  --no-source-control            Do not open Source Control during the stress loop.
  --no-dead-pty-reactivate       Do not kill PTYs and revisit workspaces after initial activation.
  --keep                         Keep disposable WSL/userData fixtures after the run.`)
}

function parsePositiveInt(name, value) {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new Error(`${name} requires a positive integer.`)
  }
  return parsed
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('This repro harness is intentionally Windows-only.')
  }
  const args = parseArgs()
  const distros = listWslDistros()
  const distro = args.distro ?? distros[0]
  if (!distro) {
    throw new Error('No user WSL distro found. Install/enable WSL or pass --distro=NAME.')
  }
  console.log(
    `[apphang-repro] issue=https://github.com/stablyai/orca/issues/6874 distro=${distro} gpuModes=${args.gpuModes.join(',')} cycles=${args.cycles}`
  )
  const fixture = createWslFixture(distro)
  console.log(
    `[apphang-repro] fixture repo=${fixture.repoUncPath} plain=${fixture.plainUncPath} base=${fixture.baseLinuxPath}`
  )

  const results = []
  try {
    for (const gpuMode of args.gpuModes) {
      results.push(await runGpuMode(gpuMode, args, fixture))
      if (args.expect === 'repro' && results.at(-1)?.reproduced) {
        break
      }
    }
  } finally {
    if (!args.keep) {
      removeWslFixture(fixture)
    }
  }

  const payload = {
    issue: 'https://github.com/stablyai/orca/issues/6874',
    expect: args.expect,
    distro,
    fixture: args.keep ? fixture : { removed: true, baseLinuxPath: fixture.baseLinuxPath },
    summary: results.map(summarizeResult),
    results
  }
  if (args.reportPath) {
    const reportPath = path.resolve(args.reportPath)
    mkdirSync(path.dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, `${JSON.stringify(payload, null, 2)}\n`)
    console.log(JSON.stringify({ reportPath, summary: payload.summary }, null, 2))
  } else {
    console.log(JSON.stringify(payload, null, 2))
  }

  // Why: a broken harness run (CDP/setup/selector failure) proves nothing —
  // it must fail both --expect=repro and --expect=pass rather than being
  // miscounted as hang evidence or as a clean pass.
  const harnessErrors = results.filter((result) => result.harnessError)
  if (harnessErrors.length > 0) {
    const harnessErrorLines = harnessErrors
      .map((result) => `  gpu=${result.gpuMode}: ${result.harnessError}`)
      .join('\n')
    console.error(
      `[apphang-repro] Harness failed in ${harnessErrors.length} run(s); result inconclusive:\n${harnessErrorLines}`
    )
    if (args.expect !== 'none') {
      process.exit(1)
    }
  }
  const reproduced = results.some((result) => result.reproduced)
  if (args.expect === 'repro' && !reproduced) {
    console.error(
      '[apphang-repro] Expected to reproduce the hang, but no hang evidence was observed.'
    )
    process.exit(1)
  }
  if (args.expect === 'pass' && reproduced) {
    console.error('[apphang-repro] Expected a clean pass, but hang evidence was observed.')
    process.exit(1)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exit(1)
})
