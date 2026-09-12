import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { runProcessSync } from './script-child-process.mjs'

const root = process.cwd()
const driver = process.argv[2] ?? 'config/scripts/orcad-managed-environment-cross-version.test.ts'
const config = 'config/vitest.config.ts'
const tempRoot = mkdtempSync(join(tmpdir(), 'orca-managed-orcad-rollback-'))

try {
  const originMainRoot = extractSource('origin/main', 'origin-main')
  for (const phase of [
    'source-fenced',
    'destination-staged',
    'destination-committed',
    'source-retired'
  ]) {
    const userDataPath = join(tempRoot, phase)
    mkdirSync(userDataPath)
    runOracle(`${phase} current write`, root, 'write-current', phase, userDataPath)
    runOracle(
      `${phase} origin/main rewrite`,
      originMainRoot,
      'rewrite-with-origin-main',
      phase,
      userDataPath
    )
    runOracle(
      `${phase} current re-upgrade repair`,
      root,
      'repair-after-reupgrade',
      phase,
      userDataPath
    )
  }
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function extractSource(commit, name) {
  const destination = join(tempRoot, name)
  const archive = join(tempRoot, `${name}.tar`)
  mkdirSync(destination)
  run('git', ['archive', '--format=tar', `--output=${archive}`, commit, 'src/main', 'src/shared'])
  run('tar', ['-xf', archive, '-C', destination])
  symlinkSync(
    join(root, 'node_modules'),
    join(destination, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  return destination
}

function runOracle(label, targetRoot, operation, phase, userDataPath) {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const result = runProcessSync({
    program: pnpm,
    args: ['exec', 'vitest', 'run', driver, '--config', config],
    cwd: root,
    timeoutMs: null,
    maxOutputBytes: 16 * 1024 * 1024,
    env: {
      ...process.env,
      ORCAD_ROLLBACK_TARGET_ROOT: resolve(targetRoot),
      ORCAD_ROLLBACK_OPERATION: operation,
      ORCAD_ROLLBACK_PHASE: phase,
      ORCAD_ROLLBACK_USER_DATA_PATH: userDataPath
    }
  })
  const output = `${result.stdout}${result.stderr}`
  if (result.code !== 0) {
    throw new Error(`${label} failed\n${output}`)
  }
  process.stdout.write(`PASS ${label}\n`)
}

function run(command, args) {
  const result = runProcessSync({
    program: command,
    args,
    cwd: root,
    timeoutMs: null,
    maxOutputBytes: 16 * 1024 * 1024
  })
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}${result.stderr}`)
  }
}
