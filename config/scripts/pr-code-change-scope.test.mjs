import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { isDocsOnlyPath, shouldRunPrChecks } from './pr-code-change-scope.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const prWorkflow = parse(readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8'))

const gatedIf = "needs.code_paths.outputs.should_run == 'true'"
const expensiveJobs = [
  'static_analysis',
  'typecheck',
  'git_compatibility',
  'xterm_patch_sync',
  'shell_contracts',
  'test',
  'cross-version-wire',
  'managed_hook_node18',
  'package',
  'package_windows'
]

describe('docs-only path classification', () => {
  it('treats the WeChat README PR files as docs-only', () => {
    expect(
      shouldRunPrChecks([
        'README.md',
        'docs/assets/wechat-qr-group8.jpg',
        'docs/readme/README.zh-CN.md'
      ])
    ).toBe(false)
  })

  it('skips root instruction files and GitHub markdown templates', () => {
    expect(isDocsOnlyPath('AGENTS.md')).toBe(true)
    expect(isDocsOnlyPath('CLAUDE.md')).toBe(true)
    expect(isDocsOnlyPath('LICENSE')).toBe(true)
    expect(isDocsOnlyPath('.github/CONTRIBUTING.md')).toBe(true)
    expect(isDocsOnlyPath('.github/pull_request_template.md')).toBe(true)
    expect(isDocsOnlyPath('.github/ISSUE_TEMPLATE/bug_report.yml')).toBe(true)
    expect(isDocsOnlyPath('.github/CODEOWNERS')).toBe(true)
  })

  it('still runs PR Checks for product markdown and CI', () => {
    expect(isDocsOnlyPath('skills/computer-use/SKILL.md')).toBe(false)
    expect(isDocsOnlyPath('skill-guides/orca-cli.md')).toBe(false)
    expect(isDocsOnlyPath('.github/workflows/pr.yml')).toBe(false)
    expect(isDocsOnlyPath('src/main/index.ts')).toBe(false)
    expect(isDocsOnlyPath('config/scripts/pr-code-change-scope.mjs')).toBe(false)
    expect(shouldRunPrChecks(['README.md', 'src/main/index.ts'])).toBe(true)
  })

  it('runs PR Checks when the diff is empty rather than skipping by accident', () => {
    expect(shouldRunPrChecks([])).toBe(true)
  })
})

describe('PR Checks docs-only skip wiring', () => {
  it('classifies the PR range with a tested script and expands renames', () => {
    const classify = prWorkflow.jobs.code_paths.steps.find(
      (step) => step.name === 'Classify changed paths'
    )
    expect(classify.run).toContain('--diff-filter=ACDMR')
    expect(classify.run).toContain('--no-renames')
    expect(classify.run).toContain('--merge-base "$BASE_SHA" "$HEAD_SHA"')
    expect(classify.run).toContain('node config/scripts/pr-code-change-scope.mjs')
    expect(prWorkflow.jobs.code_paths.outputs.should_run).toBe(
      '${{ steps.filter.outputs.should_run }}'
    )
  })

  it('keeps the cheap root-directory guard on docs-only PRs', () => {
    expect(prWorkflow.jobs.root_directory_guard.if).toBeUndefined()
    expect(prWorkflow.jobs.root_directory_guard.needs).toBeUndefined()
  })

  it('skips expensive jobs unless the detector says the PR has code', () => {
    for (const jobName of expensiveJobs) {
      expect(prWorkflow.jobs[jobName].needs, jobName).toEqual(['code_paths'])
      expect(prWorkflow.jobs[jobName].if, jobName).toBe(gatedIf)
    }
  })

  it('skips e2e detection on docs-only PRs without dropping the draft gate', () => {
    expect(prWorkflow.jobs['e2e-paths'].needs).toEqual(['code_paths'])
    expect(prWorkflow.jobs['e2e-paths'].if).toBe(
      "github.event.pull_request.draft != true && needs.code_paths.outputs.should_run == 'true'"
    )
  })

  it('lets verify pass when expensive jobs are skipped for docs-only PRs', () => {
    const verifyStep = prWorkflow.jobs.verify.steps.find(
      (step) => step.name === 'Require successful checks'
    )
    expect(prWorkflow.jobs.verify.needs[0]).toBe('code_paths')
    expect(verifyStep.env.SHOULD_RUN).toBe('${{ needs.code_paths.outputs.should_run }}')
    expect(verifyStep.run).toContain('"$SHOULD_RUN" != "true"')
    const docsOnlyBranch = verifyStep.run.slice(
      0,
      verifyStep.run.indexOf('# Require success when the PR has code-relevant changes')
    )
    expect(docsOnlyBranch).toContain('if [ "$result" != "skipped" ]')
    expect(docsOnlyBranch).not.toContain('"$result" != "success"')
    expect(verifyStep.run).toContain('"$ROOT_DIRECTORY_GUARD" != "success"')
  })
})
