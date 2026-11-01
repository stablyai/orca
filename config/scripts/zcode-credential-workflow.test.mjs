import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/zcode-credential-contract.yml', 'utf8'))
const accountWorkflow = parse(readFileSync('.github/workflows/zcode-account-contract.yml', 'utf8'))
const job = workflow.jobs['credential-files']
const scope = job.steps.find((step) => step.id === 'scope')
const account = job.steps.find(
  (step) => step.name === 'Verify read-only credentials and account changes'
)
const credentials = job.steps.find(
  (step) => step.name === 'Verify rollback and native Windows permissions'
)
const accountFiles = [
  'src/main/zcode/zcode-v2-plan-credentials.test.ts',
  'src/main/zcode/zcode-v2-personal-overlay-raw-json.test.ts',
  'src/main/rate-limits/service-zcode-usage.test.ts',
  'src/shared/node-bounded-file-reader-sync.test.ts'
]
const credentialFiles = [
  'src/main/zcode/zcode-plan-api-key-store.test.ts',
  'src/main/zcode/zcode-plan-api-key-store-plaintext-rollback.test.ts',
  'src/main/zcode/zcode-plan-api-key-store-publication-race.test.ts',
  'src/main/zcode/zcode-plan-api-key-store-native-windows.test.ts',
  'src/shared/secure-file.test.ts'
]

it('shares one bootstrap across the original modules and operating systems', () => {
  expect(job.strategy).toEqual({
    'fail-fast': false,
    matrix: { os: ['ubuntu-22.04', 'macos-15', 'windows-2022'] }
  })
  expect(job.name).toBe('ZCode credentials (${{ matrix.os }})')
  expect(account.run.split(/\s+/).slice(2)).toEqual(accountFiles)
  expect(credentials.run.split(/\s+/).slice(2)).toEqual(credentialFiles)
  expect(
    job.steps.filter((step) => step.uses === './.github/actions/install-node-dependencies')
  ).toHaveLength(1)
  expect(job.steps.find((step) => step.id === 'dependencies').with['native-runtime']).toBe('node')
  expect(job.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
  expect(job['timeout-minutes']).toBe(20)
  expect(job.steps[0].with['fetch-depth']).toBe(2)
  expect(workflow.on.pull_request.paths).toEqual([
    'src/main/zcode/**',
    'src/shared/node-bounded-file-reader*',
    'src/main/rate-limits/**',
    'src/shared/secure-file*',
    'src/shared/secure-path-windows-acl*',
    'src/shared/windows-security-descriptor*',
    '.github/workflows/zcode-account-contract.yml',
    '.github/workflows/zcode-credential-contract.yml',
    'config/scripts/zcode-credential-workflow.test.mjs'
  ])
  expect(accountWorkflow.on).toEqual({ workflow_dispatch: null })
  expect(accountWorkflow.jobs['account-contract']).toEqual({
    uses: './.github/workflows/zcode-credential-contract.yml',
    with: { contract: 'account' }
  })
  expect(workflow.on.workflow_dispatch).toBeNull()
  expect(workflow.on.workflow_call.inputs.contract.default).toBe('credentials')
})

it('runs the other selected contract after a sibling fails and retains prerequisite failures', () => {
  for (const step of [account, credentials]) {
    expect(step['continue-on-error']).toBeUndefined()
    for (const [cancelled, installed, bun, selected, expected] of [
      [false, 'success', 'success', 'true', true],
      [false, 'failure', 'success', 'true', false],
      [false, 'success', 'failure', 'true', false],
      [false, 'success', 'success', 'false', false],
      [true, 'success', 'success', 'true', false]
    ]) {
      expect(
        runInNewContext(step.if.slice(3, -2), {
          cancelled: () => cancelled,
          steps: {
            scope: { outputs: { account: selected, credentials: selected } },
            dependencies: { outcome: installed },
            bun: { outcome: bun }
          }
        })
      ).toBe(expected)
    }
  }
})

function executeScope(directory, overrides = {}) {
  const output = join(directory, 'github-output')
  writeFileSync(output, '')
  execFileSync('bash', ['-e', '-o', 'pipefail', '-c', scope.run], {
    cwd: directory,
    env: {
      ...process.env,
      ORCA_BACKGROUND_LAUNCH: '1',
      EVENT_NAME: 'pull_request',
      MANUAL_ACCOUNT: 'false',
      MANUAL_CREDENTIALS: 'true',
      GITHUB_OUTPUT: output,
      ...overrides
    }
  })
  return Object.fromEntries(
    readFileSync(output, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('='))
  )
}

// The workflow owns Bash execution on Windows; this contract executes the same source on Unix.
it.skipIf(process.platform === 'win32')(
  'selects the original path groups, including deletions and renames',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-zcode-workflow-'))
    const git = (args) => execFileSync('git', args, { cwd: directory, stdio: 'pipe' })
    const write = (file, value) => {
      mkdirSync(dirname(join(directory, file)), { recursive: true })
      writeFileSync(join(directory, file), value)
    }
    const commit = () => {
      git(['add', '-A'])
      git([
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '--allow-empty',
        '-qm',
        'fixture'
      ])
    }
    const cases = [
      ['src/main/zcode/credentials.ts', true, true],
      ['src/main/zcode/nested/credentials.ts', true, true],
      ['src/shared/node-bounded-file-reader-sync.test.ts', true, false],
      ['src/main/rate-limits/service-zcode-usage.ts', true, false],
      ['src/shared/secure-file.ts', false, true],
      ['src/shared/secure-path-windows-acl.ts', false, true],
      ['src/shared/windows-security-descriptor.ts', false, true],
      ['.github/workflows/zcode-account-contract.yml', true, false],
      ['.github/workflows/zcode-credential-contract.yml', true, true],
      ['config/scripts/zcode-credential-workflow.test.mjs', true, true],
      ['docs/unrelated.md', false, false]
    ]
    try {
      git(['init', '-q'])
      write('README.md', 'fixture')
      commit()
      expect(executeScope(directory)).toEqual({ account: 'true', credentials: 'true' })
      for (const [file, runsAccount, runsCredentials] of cases) {
        write(file, 'first')
        commit()
        expect(executeScope(directory), file).toEqual({
          account: String(runsAccount),
          credentials: String(runsCredentials)
        })
        rmSync(join(directory, file))
        commit()
        expect(executeScope(directory), `deleted ${file}`).toEqual({
          account: String(runsAccount),
          credentials: String(runsCredentials)
        })
      }
      write('src/main/zcode/credentials.ts', 'renamed')
      commit()
      renameSync(join(directory, 'src/main/zcode/credentials.ts'), join(directory, 'README.md'))
      commit()
      expect(executeScope(directory)).toEqual({ account: 'true', credentials: 'true' })
      write('src/main/rate-limits/service.ts', 'mixed')
      write('src/shared/secure-file.ts', 'mixed')
      commit()
      expect(executeScope(directory)).toEqual({ account: 'true', credentials: 'true' })
      commit()
      expect(executeScope(directory)).toEqual({ account: 'true', credentials: 'true' })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'keeps both manual entry points and missing diff evidence',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-zcode-manual-'))
    try {
      expect(executeScope(directory)).toEqual({ account: 'true', credentials: 'true' })
      expect(executeScope(directory, { EVENT_NAME: 'workflow_dispatch' })).toEqual({
        account: 'false',
        credentials: 'true'
      })
      expect(
        executeScope(directory, {
          EVENT_NAME: 'workflow_dispatch',
          MANUAL_ACCOUNT: 'true',
          MANUAL_CREDENTIALS: 'false'
        })
      ).toEqual({ account: 'true', credentials: 'false' })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'runs both groups when the full diff fails even if scoped diffs would report no changes',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-zcode-diff-failure-'))
    try {
      const gitShim = join(directory, 'git')
      writeFileSync(
        gitShim,
        '#!/bin/sh\nif [ "$1" = rev-parse ]; then exit 0; fi\nif [ "$#" = 5 ]; then exit "$FULL_DIFF_STATUS"; fi\nexit 0\n'
      )
      chmodSync(gitShim, 0o755)
      const env = { PATH: `${directory}${delimiter}${process.env.PATH}` }
      expect(executeScope(directory, { ...env, FULL_DIFF_STATUS: '1' })).toEqual({
        account: 'false',
        credentials: 'false'
      })
      for (const status of ['2', '128']) {
        expect(executeScope(directory, { ...env, FULL_DIFF_STATUS: status })).toEqual({
          account: 'true',
          credentials: 'true'
        })
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
