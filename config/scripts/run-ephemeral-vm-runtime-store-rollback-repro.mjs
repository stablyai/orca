import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const BASELINE_COMMIT = 'bf0c77d5bc800e19117084c27fd1441eda9134ad'
const AFFECTED_MAIN_COMMIT = '25abb9368d98ad84a174f530e02f4228d2269062'
const root = process.cwd()
const driver = process.argv[2] ?? 'config/scripts/ephemeral-vm-runtime-store-cross-version.test.ts'
const config = 'config/vitest.config.ts'
const tempRoot = mkdtempSync(join(tmpdir(), 'orca-sta-4274-repro-'))

try {
  const baselineRoot = extractSource(BASELINE_COMMIT, 'baseline')
  const affectedRoot = extractSource(AFFECTED_MAIN_COMMIT, 'affected-main')
  const revertedRoot = extractSource('HEAD', 'candidate-reverted')
  restoreAffectedStoreFiles(revertedRoot)

  const baselineData = makeDataDir('baseline-data')
  runOracle('baseline write', baselineRoot, 'write-legacy', baselineData)
  runOracle('baseline read', baselineRoot, 'read-legacy', baselineData)

  const affectedData = makeDataDir('affected-data')
  runOracle('affected write', affectedRoot, 'write-mixed', affectedData)
  runOracle('affected current read', affectedRoot, 'read', affectedData)
  runOracle('affected rollback read', baselineRoot, 'read', affectedData, {
    expectFailure: 'file is invalid'
  })

  const candidateData = makeDataDir('candidate-data')
  runOracle('candidate write', root, 'write-mixed', candidateData)
  runOracle(
    'candidate rollback projection',
    baselineRoot,
    'read-rollback-projection',
    candidateData
  )
  runOracle('rollback lifecycle mutation', baselineRoot, 'mutate-lifecycle', candidateData)
  runOracle('candidate re-upgrade', root, 'read-after-downgrade', candidateData)

  const revertedData = makeDataDir('reverted-data')
  runOracle('reverted write', revertedRoot, 'write-mixed', revertedData)
  runOracle('reverted rollback read', baselineRoot, 'read', revertedData, {
    expectFailure: 'file is invalid'
  })
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}

function extractSource(commit, name) {
  const destination = join(tempRoot, name)
  const archive = join(tempRoot, `${name}.tar`)
  mkdirSync(destination)
  run('git', ['archive', '--format=tar', `--output=${archive}`, commit, 'src/main', 'src/shared'])
  run('tar', ['-xf', archive, '-C', destination])
  return destination
}

function restoreAffectedStoreFiles(destination) {
  for (const relativePath of [
    'src/shared/ephemeral-vm-runtime-store.ts',
    'src/shared/ephemeral-vm-runtimes.ts'
  ]) {
    const result = run('git', ['show', `${AFFECTED_MAIN_COMMIT}:${relativePath}`], {
      encoding: 'utf8'
    })
    writeFileSync(join(destination, relativePath), result.stdout)
  }
}

function makeDataDir(name) {
  const destination = join(tempRoot, name)
  mkdirSync(destination)
  return destination
}

function runOracle(label, targetRoot, operation, userDataPath, options = {}) {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const result = spawnSync(pnpm, ['exec', 'vitest', 'run', driver, '--config', config], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      STA_4274_TARGET_ROOT: resolve(targetRoot),
      STA_4274_OPERATION: operation,
      STA_4274_USER_DATA_PATH: userDataPath
    }
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (options.expectFailure) {
    if (result.status === 0 || !output.includes(options.expectFailure)) {
      throw new Error(
        `${label} did not fail with ${JSON.stringify(options.expectFailure)}\n${output}`
      )
    }
    process.stdout.write(`EXPECTED_FAIL ${label}\n`)
    return
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed\n${output}`)
  }
  process.stdout.write(`PASS ${label}\n`)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: options.encoding,
    maxBuffer: 16 * 1024 * 1024
  })
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed\n${String(result.stdout ?? '')}${String(result.stderr ?? '')}`
    )
  }
  return result
}
