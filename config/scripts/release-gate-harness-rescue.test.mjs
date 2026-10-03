import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import {
  RESCUABLE_HARNESS_FILES,
  buildRescueGrep,
  main,
  planHarnessRescue,
  verifyHarnessRescue
} from './release-gate-harness-rescue.mjs'

const SPEC = 'tests/e2e/golden-worktree-create-switch.spec.ts'
const repoDirs = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of repoDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function playwrightReport(repoDir, specs, errors = []) {
  const suites = Object.entries(specs).map(([file, tests]) => ({
    title: file,
    file,
    specs: tests.map(([title, status]) => ({
      title,
      file,
      tests: [{ projectName: 'electron-headless', status }]
    }))
  }))
  return { config: { rootDir: join(repoDir, 'tests/e2e') }, suites, errors }
}

describe('planHarnessRescue', () => {
  const repoDir = '/repo'

  it('rescues only failures confined to vetted harness specs', () => {
    const plan = planHarnessRescue(
      playwrightReport(repoDir, {
        'golden-worktree-create-switch.spec.ts': [['switches back @golden', 'unexpected']],
        'golden-quit-relaunch-session.spec.ts': [['relaunches @golden', 'expected']]
      }),
      { repoDir }
    )

    expect(plan.rescuable).toBe(true)
    expect(plan.files).toEqual([SPEC])
  })

  it('re-runs tests a failure left unrun, but not declared skips', () => {
    const report = playwrightReport(repoDir, {
      'golden-worktree-create-switch.spec.ts': [
        ['switches back', 'unexpected'],
        ['then reopens', 'skipped'],
        ['skipped on this platform', 'skipped']
      ]
    })
    // Shapes from Playwright 1.59: serial mode reports an unrun test as skipped but still expected to pass.
    const [failed, unrun, declared] = report.suites[0].specs
    failed.tests[0].expectedStatus = 'passed'
    unrun.tests[0].expectedStatus = 'passed'
    declared.tests[0].expectedStatus = 'skipped'

    const plan = planHarnessRescue(report, { repoDir })

    expect(plan.rescuable).toBe(true)
    expect(plan.failedTests.map((test) => test.titlePath[0])).toEqual([
      'switches back',
      'then reopens'
    ])
  })

  it('refuses when any failure is outside the vetted harness specs', () => {
    const plan = planHarnessRescue(
      playwrightReport(repoDir, {
        'golden-worktree-create-switch.spec.ts': [['switches back @golden', 'unexpected']],
        'golden-quit-relaunch-session.spec.ts': [['relaunches @golden', 'unexpected']]
      }),
      { repoDir }
    )

    expect(plan).toMatchObject({ rescuable: false })
    expect(plan.reason).toContain('golden-quit-relaunch-session.spec.ts')
  })

  it('refuses setup errors, unattributed failures, and missing reports', () => {
    const passing = { 'golden-worktree-create-switch.spec.ts': [['switches back', 'expected']] }

    expect(planHarnessRescue(null, { repoDir }).rescuable).toBe(false)
    expect(planHarnessRescue(playwrightReport(repoDir, passing), { repoDir }).rescuable).toBe(false)
    expect(
      planHarnessRescue(playwrightReport(repoDir, passing, [{ message: 'global setup' }]), {
        repoDir
      }).rescuable
    ).toBe(false)
  })
})

describe('buildRescueGrep', () => {
  it('selects exactly the failed test by file and title path', () => {
    const grep = new RegExp(
      buildRescueGrep([
        {
          suiteFile: 'golden-terminal-file-link.spec.ts',
          titlePath: ['reuses a link (sibling) $HOME @golden']
        }
      ])
    )
    // Playwright matches --grep against "<project> <file> <describes> <title> <tags>".
    const title =
      ' electron-headless golden-terminal-file-link.spec.ts reuses a link (sibling) $HOME @golden golden'

    expect(grep.test(title)).toBe(true)
    expect(grep.test(title.replace('golden-terminal-file-link', 'golden-other'))).toBe(false)
  })
})

describe('verifyHarnessRescue', () => {
  const repoDir = '/repo'
  const failed = [
    {
      file: SPEC,
      suiteFile: 'golden-worktree-create-switch.spec.ts',
      titlePath: ['switches back'],
      projectName: 'electron-headless',
      status: 'unexpected'
    }
  ]

  it('accepts only when the same test re-ran and passed', () => {
    const rerun = (status, title = 'switches back') =>
      playwrightReport(repoDir, { 'golden-worktree-create-switch.spec.ts': [[title, status]] })

    expect(verifyHarnessRescue(failed, rerun('expected'), { repoDir }).rescued).toBe(true)
    expect(verifyHarnessRescue(failed, rerun('unexpected'), { repoDir }).rescued).toBe(false)
    // A renamed or deleted test must not pass vacuously.
    expect(verifyHarnessRescue(failed, rerun('expected', 'renamed'), { repoDir }).rescued).toBe(
      false
    )
    expect(verifyHarnessRescue(failed, null, { repoDir }).rescued).toBe(false)
  })
})

// A fake gate: each spec line `test <title> = pass|fail` becomes a Playwright JSON result.
const FAKE_GATE = `
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
rmSync('test-results', { recursive: true, force: true })
const grepArg = process.argv.find((arg) => arg.startsWith('--grep='))
const grep = grepArg ? new RegExp(grepArg.slice('--grep='.length)) : null
const rootDir = join(process.cwd(), 'tests/e2e')
const suites = []
let failed = false
for (const file of readdirSync(rootDir).sort()) {
  const specs = []
  for (const line of readFileSync(join(rootDir, file), 'utf8').split('\\n')) {
    const match = /^test (.+) = (pass|fail)$/.exec(line)
    if (!match || (grep && !grep.test(' electron-headless ' + file + ' ' + match[1]))) continue
    failed ||= match[2] === 'fail'
    if (match[2] === 'fail') {
      mkdirSync('test-results', { recursive: true })
      writeFileSync(join('test-results', match[1] + '.trace'), '')
    }
    specs.push({ title: match[1], file, tests: [{ projectName: 'electron-headless', status: match[2] === 'pass' ? 'expected' : 'unexpected' }] })
  }
  if (specs.length) suites.push({ title: file, file, specs })
}
writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify({ config: { rootDir }, suites, errors: [] }))
process.exitCode = failed || suites.length === 0 ? 1 : 0
`

function git(repoDir, ...args) {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim()
}

/** Builds a repo whose HEAD is the tag and returns the workflow-ref commit. */
function makeCut({ tag, workflow, other = 'test relaunches = pass\n' }) {
  const repoDir = mkdtempSync(join(tmpdir(), 'release-gate-rescue-'))
  repoDirs.push(repoDir)
  mkdirSync(join(repoDir, 'tests/e2e'), { recursive: true })
  writeFileSync(join(repoDir, 'fake-gate.mjs'), FAKE_GATE)
  git(repoDir, 'init', '-q')
  git(repoDir, 'config', 'user.email', 'ci@example.com')
  git(repoDir, 'config', 'user.name', 'ci')
  writeFileSync(join(repoDir, SPEC), workflow)
  writeFileSync(join(repoDir, 'tests/e2e/golden-quit-relaunch-session.spec.ts'), other)
  git(repoDir, 'add', '.')
  git(repoDir, 'commit', '-qm', 'workflow ref')
  const workflowSha = git(repoDir, 'rev-parse', 'HEAD')
  writeFileSync(join(repoDir, SPEC), tag)
  git(repoDir, 'commit', '-qam', 'tag', '--allow-empty')
  return { repoDir, workflowSha }
}

function runRescue({ repoDir, workflowSha }) {
  const summary = join(repoDir, 'summary.md')
  vi.stubEnv('GITHUB_STEP_SUMMARY', summary)
  const status = main(
    [
      '--label',
      'workspace-session-linux',
      '--workflow-sha',
      workflowSha,
      '--',
      process.execPath,
      'fake-gate.mjs'
    ],
    repoDir
  )
  return { status, summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '' }
}

describe('release gate harness rescue', () => {
  it("passes on the tag's own specs even when main adds a behaviour test the tag lacks", () => {
    const cut = makeCut({
      tag: 'test switches back = pass\n',
      workflow: 'test switches back = pass\ntest reports new behaviour = fail\n'
    })

    expect(runRescue(cut).status).toBe(0)
    expect(readdirSync(join(cut.repoDir, 'release-gate-rescue/workspace-session-linux'))).toEqual([
      'tag-run.json'
    ])
  })

  it("rescues a tag harness failure with main's copy and restores the tag's spec", () => {
    const tagSpec = 'test switches back = fail\ntest opens = pass\n'
    const cut = makeCut({
      tag: tagSpec,
      workflow: 'test switches back = pass\ntest opens = pass\ntest reports new behaviour = fail\n'
    })

    const result = runRescue(cut)

    expect(result.status).toBe(0)
    expect(result.summary).toContain('passed only with the workflow ref')
    expect(readFileSync(join(cut.repoDir, SPEC), 'utf8')).toBe(tagSpec)
    // Playwright empties test-results on the re-run, so the tag run's first-failure trace must move.
    expect(
      readdirSync(
        join(cut.repoDir, 'release-gate-rescue/workspace-session-linux/tag-run-test-results')
      )
    ).toEqual(['switches back.trace'])
    const rescueRun = JSON.parse(
      readFileSync(
        join(cut.repoDir, 'release-gate-rescue/workspace-session-linux/rescue-run.json'),
        'utf8'
      )
    )
    // Only the failed test re-runs, so main's new behaviour test never executes.
    expect(rescueRun.suites.flatMap((suite) => suite.specs.map((spec) => spec.title))).toEqual([
      'switches back'
    ])
  })

  it('does not rescue a failure outside the vetted harness specs', () => {
    const cut = makeCut({
      tag: 'test switches back = fail\n',
      workflow: 'test switches back = pass\n',
      other: 'test relaunches = fail\n'
    })

    const result = runRescue(cut)

    expect(result.status).not.toBe(0)
    expect(result.summary).toContain('golden-quit-relaunch-session.spec.ts')
  })

  it("does not rescue when main's copy renamed the failed test", () => {
    const cut = makeCut({
      tag: 'test switches back = fail\n',
      workflow: 'test switches back and forth = pass\n'
    })

    expect(runRescue(cut).status).not.toBe(0)
  })

  it('does not rescue when the workflow ref has no newer harness', () => {
    const spec = 'test switches back = fail\n'
    const cut = makeCut({ tag: spec, workflow: spec })

    const result = runRescue(cut)

    expect(result.status).not.toBe(0)
    expect(result.summary).toContain('no newer harness')
  })
})

describe('release workflows judge a tag by its own tests', () => {
  const TEST_PATH = /(^|\/)(tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/

  function workflowRefRestores(workflowFile) {
    const workflow = parse(readFileSync(workflowFile, 'utf8'))
    return Object.entries(workflow.jobs).flatMap(([jobName, job]) =>
      (job.steps ?? []).flatMap((step) =>
        (step.run ?? '')
          .replace(/\\\n/g, ' ')
          .split('\n')
          .filter((line) => line.includes('git checkout "$WORKFLOW_SHA" --'))
          .flatMap((line) => line.split('git checkout "$WORKFLOW_SHA" --')[1].trim().split(/\s+/))
          .map((path) => ({ jobName, path }))
      )
    )
  }

  it('never overlays a test file from the workflow ref onto a release tag', () => {
    const restores = [
      '.github/workflows/release-cut.yml',
      '.github/workflows/release-mac-build.yml'
    ].flatMap(workflowRefRestores)

    // Positive control: the scan must see the tooling restores that do exist.
    expect(restores).toContainEqual({
      jobName: 'terminal-rendering-golden',
      path: 'config/scripts/release-gate-harness-rescue.mjs'
    })
    expect(restores.filter(({ path }) => TEST_PATH.test(path))).toEqual([])
  })

  it('routes every golden command that runs a rescuable spec through the rescue', () => {
    const workflow = parse(readFileSync('.github/workflows/release-cut.yml', 'utf8'))
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
    const scripts = Object.entries(packageJson.scripts)
      .filter(([, command]) => RESCUABLE_HARNESS_FILES.some((file) => command.includes(file)))
      .map(([name]) => name)
    const commands = workflow.jobs['terminal-rendering-golden'].steps
      .flatMap((step) => (step.run ?? '').split('\n'))
      .filter((line) => scripts.some((name) => new RegExp(`\\b${name}$`).test(line.trim())))

    expect(scripts.sort()).toEqual([
      'test:e2e:source-control-golden',
      'test:e2e:workspace-session-golden'
    ])
    expect(commands).toHaveLength(4)
    for (const command of commands) {
      expect(command).toMatch(
        /^node config\/scripts\/release-gate-harness-rescue\.mjs --label [a-z-]+ -- /
      )
    }
    expect(workflow.jobs['terminal-rendering-golden'].env.WORKFLOW_SHA).toBe(
      '${{ github.workflow_sha }}'
    )
  })
})
