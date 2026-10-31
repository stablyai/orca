import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, expect, it } from 'vitest'
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
let fixtureHome
beforeEach(() => {
  fixtureHome = mkdtempSync(join(tmpdir(), 'orca-zcode-home-'))
  writeFileSync(join(fixtureHome, '.gitconfig'), '')
})
afterEach(() => rmSync(fixtureHome, { recursive: true, force: true }))

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
    env: fixtureEnvironment({
      ...process.env,
      ORCA_BACKGROUND_LAUNCH: '1',
      EVENT_NAME: 'pull_request',
      MANUAL_ACCOUNT: 'false',
      MANUAL_CREDENTIALS: 'true',
      GITHUB_OUTPUT: output,
      ...overrides
    })
  })
  return Object.fromEntries(
    readFileSync(output, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split('='))
  )
}

function fixtureEnvironment(inheritedEnv) {
  return {
    ...Object.fromEntries(
      Object.entries(inheritedEnv).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
    ),
    HOME: fixtureHome,
    USERPROFILE: fixtureHome,
    XDG_CONFIG_HOME: fixtureHome,
    GIT_CONFIG_GLOBAL: join(fixtureHome, '.gitconfig'),
    GIT_CONFIG_SYSTEM: join(fixtureHome, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1'
  }
}

function createScopeFixture(directory, inheritedEnv = process.env) {
  const git = (args) =>
    execFileSync('git', args, {
      cwd: directory,
      stdio: 'pipe',
      env: {
        ...fixtureEnvironment(inheritedEnv),
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.test',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.test'
      }
    })
  let parent
  const commit = () => {
    git(['add', '-A'])
    const tree = git(['write-tree']).toString().trim()
    parent = git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'fixture'])
      .toString()
      .trim()
    expect(realpathSync.native(git(['rev-parse', '--absolute-git-dir']).toString().trim())).toBe(
      realpathSync.native(join(directory, '.git'))
    )
    git(['update-ref', 'HEAD', parent])
  }
  git(['init', '-q'])
  expect(realpathSync.native(git(['rev-parse', '--absolute-git-dir']).toString().trim())).toBe(
    realpathSync.native(join(directory, '.git'))
  )
  return { git, commit }
}

it('keeps fixture commits independent of host-required content filters', () => {
  const home = mkdtempSync(join(tmpdir(), 'orca-zcode-filter-home-'))
  const directory = mkdtempSync(join(tmpdir(), 'orca-zcode-filter-repo-'))
  try {
    const attributes = join(home, 'attributes')
    writeFileSync(attributes, '* filter=unavailable\n')
    const contents = `[core]\n\tattributesFile = ${JSON.stringify(attributes)}\n[filter "unavailable"]\n\tclean = orca-fixture-missing-clean-filter\n\trequired = true\n`
    const config = join(home, '.gitconfig')
    writeFileSync(config, contents)
    const emptyConfig = join(home, 'empty-config')
    writeFileSync(emptyConfig, '')
    const fixture = createScopeFixture(directory, {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: home,
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_SYSTEM: config
    })
    writeFileSync(join(directory, 'README.md'), 'fixture content')
    fixture.commit()

    expect(fixture.git(['rev-list', '--count', 'HEAD']).toString().trim()).toBe('1')
    expect(readFileSync(config, 'utf8')).toBe(contents)
    expect(readFileSync(emptyConfig, 'utf8')).toBe('')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(directory, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32').each(['repository pointers', 'config overrides'])(
  'keeps an external repository unchanged with inherited Git %s',
  (contamination) => {
    const caller = mkdtempSync(join(tmpdir(), 'orca-zcode-caller-'))
    const directory = mkdtempSync(join(tmpdir(), 'orca-zcode-isolated-'))
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
    )
    try {
      const external = createScopeFixture(caller, cleanEnv)
      writeFileSync(join(caller, 'README.md'), 'caller content')
      external.commit()
      const paths = ['HEAD', 'config', 'index'].map((name) => join(caller, '.git', name))
      const before = paths.map((path) => readFileSync(path))
      const refsBefore = external.git(['show-ref']).toString()
      const inheritedGitEnv =
        contamination === 'repository pointers'
          ? {
              GIT_DIR: join(caller, '.git'),
              GIT_WORK_TREE: caller,
              GIT_COMMON_DIR: join(caller, '.git'),
              GIT_INDEX_FILE: join(caller, '.git', 'index'),
              GIT_OBJECT_DIRECTORY: join(caller, '.git', 'objects'),
              GIT_ALTERNATE_OBJECT_DIRECTORIES: join(caller, '.git', 'objects')
            }
          : {
              GIT_CONFIG: join(caller, '.git', 'config'),
              GIT_CONFIG_PARAMETERS: "'user.name=Injected Author'",
              GIT_CONFIG_COUNT: '1',
              GIT_CONFIG_KEY_0: 'core.bare',
              GIT_CONFIG_VALUE_0: 'true'
            }
      const fixture = createScopeFixture(directory, { ...cleanEnv, ...inheritedGitEnv })
      writeFileSync(join(directory, 'README.md'), 'fixture content')
      fixture.commit()
      mkdirSync(join(directory, 'src', 'main', 'zcode'), { recursive: true })
      writeFileSync(join(directory, 'src', 'main', 'zcode', 'credentials.ts'), 'fixture')
      fixture.commit()

      expect(realpathSync(fixture.git(['rev-parse', '--absolute-git-dir']).toString().trim())).toBe(
        realpathSync(join(directory, '.git'))
      )
      expect(executeScope(directory, inheritedGitEnv)).toEqual({
        account: 'true',
        credentials: 'true'
      })
      expect(fixture.git(['rev-list', '--count', 'HEAD']).toString().trim()).toBe('2')
      expect(paths.map((path) => readFileSync(path))).toEqual(before)
      expect(external.git(['show-ref']).toString()).toBe(refsBefore)
      expect(readFileSync(join(caller, 'README.md'), 'utf8')).toBe('caller content')
    } finally {
      rmSync(directory, { recursive: true, force: true })
      rmSync(caller, { recursive: true, force: true })
    }
  }
)

// The workflow owns Bash execution on Windows; this contract executes the same source on Unix.
it.skipIf(process.platform === 'win32').each([
  ['default caller', {}],
  [
    'caller identity',
    {
      GIT_AUTHOR_NAME: 'Caller',
      GIT_AUTHOR_EMAIL: 'caller@example.test',
      GIT_COMMITTER_NAME: 'Caller',
      GIT_COMMITTER_EMAIL: 'caller@example.test'
    }
  ]
])(
  'selects the original path groups, including deletions and renames (%s)',
  (_label, inheritedIdentity) => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-zcode-workflow-'))
    const write = (file, value) => {
      mkdirSync(dirname(join(directory, file)), { recursive: true })
      writeFileSync(join(directory, file), value)
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
      const { git, commit } = createScopeFixture(directory, {
        ...process.env,
        ...inheritedIdentity
      })
      write('README.md', 'fixture')
      commit()
      expect(git(['reflog', 'show', '--format=%gn <%ge>', '-1', 'HEAD']).toString().trim()).toBe(
        'Fixture <fixture@example.test>'
      )
      expect(git(['show', '-s', '--format=%an <%ae>', 'HEAD']).toString().trim()).toBe(
        'Fixture <fixture@example.test>'
      )
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
