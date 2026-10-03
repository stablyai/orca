#!/usr/bin/env node
/**
 * Install the standalone CLI tarball offline into a throwaway npm prefix and run
 * the commands that must work with no Orca runtime. CI runs this on each
 * supported Node major and inside node:*-alpine, so it uses only Node builtins.
 */
// Why direct child_process: this file runs in a bare Node container with no repo
// dependencies, on Linux and macOS CI only, so the run-process wrapper is unavailable.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const STANDALONE_REFUSAL = 'is not available in the standalone Orca CLI'

function run(command, args, env) {
  const result = spawnSync(command, args, { encoding: 'utf8', env, timeout: 120_000 })
  if (result.error) {
    throw result.error
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function expectRun(label, result, { status = 0, stdout, stderr } = {}) {
  const problems = []
  if (result.status !== status) {
    problems.push(`exit ${result.status}, expected ${status}`)
  }
  if (stdout && !stdout(result.stdout)) {
    problems.push('unexpected stdout')
  }
  if (stderr && !stderr(result.stderr)) {
    problems.push('unexpected stderr')
  }
  if (problems.length > 0) {
    throw new Error(
      `${label}: ${problems.join('; ')}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`
    )
  }
  process.stdout.write(`ok  ${label}\n`)
}

function parseJson(label, text) {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${label} did not print JSON:\n${text}`)
  }
}

export function smokeStandaloneCliTarball(tarballPath) {
  const work = mkdtempSync(join(tmpdir(), 'orca-cli-smoke-'))
  const prefix = join(work, 'prefix')
  // Why: a scrubbed env keeps a developer's ORCA_* pairing or profile out of the run.
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: join(work, 'home'),
    ORCA_USER_DATA_PATH: join(work, 'user-data'),
    npm_config_cache: join(work, 'npm-cache'),
    // Why: an unroutable registry proves the install needs no network, even if --offline regresses.
    npm_config_registry: 'http://127.0.0.1:9/',
    npm_config_update_notifier: 'false'
  }
  try {
    expectRun(
      'npm install -g --offline <tarball>',
      run(
        'npm',
        [
          'install',
          '--global',
          '--offline',
          '--no-audit',
          '--no-fund',
          '--prefix',
          prefix,
          tarballPath
        ],
        env
      )
    )
    const manifest = JSON.parse(
      readFileSync(join(prefix, 'lib', 'node_modules', 'orca-cli', 'package.json'), 'utf8')
    )
    const orca = join(prefix, 'bin', 'orca')

    expectRun('orca --version', run(orca, ['--version'], env), {
      stdout: (out) => out.trim() === manifest.version
    })
    const versionJson = run(orca, ['--version', '--json'], env)
    expectRun('orca --version --json', versionJson)
    const report = parseJson('orca --version --json', versionJson.stdout)
    if (
      report.client?.version !== manifest.version ||
      report.client?.standalone !== true ||
      typeof report.client?.runtimeProtocolVersion !== 'number' ||
      report.server?.reachable !== false
    ) {
      throw new Error(`orca --version --json reported ${versionJson.stdout}`)
    }
    expectRun('orca --help', run(orca, ['--help'], env), {
      stdout: (out) => out.includes('Standalone CLI:')
    })
    expectRun('orca status --json', run(orca, ['status', '--json'], env), {
      stdout: (out) => {
        const status = parseJson('orca status --json', out).result
        return status?.client?.standalone === true && status?.runtime?.reachable === false
      }
    })
    expectRun('orca open is refused', run(orca, ['open'], env), {
      status: 1,
      stderr: (err) => err.includes(STANDALONE_REFUSAL)
    })
    expectRun('orca skills get orca-cli', run(orca, ['skills', 'get', 'orca-cli'], env), {
      stdout: (out) => out.includes('name: orca-cli')
    })
    process.stdout.write(`Standalone CLI ${manifest.version} passed on Node ${process.version}\n`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tarball = process.argv[2]
  if (!tarball) {
    console.error('Usage: node config/scripts/smoke-standalone-cli-tarball.mjs <orca-cli.tgz>')
    process.exit(2)
  }
  try {
    smokeStandaloneCliTarball(resolve(tarball))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
