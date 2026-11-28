// The main-push workflow against real Git: push files on top of a setup, plan the push, or run the plan step
// and then the lint step from its plan file, as the workflow does, with stdout and the summary captured.
import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { vi } from 'vitest'
import { main as lint } from './ci-main-push-changed-lint.mjs'
import { createGitFixture, REPO_ROOT } from './main-push-git-test-fixture.mjs'
import { planLint } from './main-push-plan.mjs'
import { main as plan } from './plan-main-push-lint.mjs'

export function createWorkflowFixture() {
  const gitFixture = createGitFixture()
  const { git, commit, makeOrigin, shallowCheckout, scratchFile } = gitFixture

  // Push `files` on top of `setup`, returning the push's before and after SHAs.
  function push(setup, files) {
    const origin = makeOrigin()
    const before = commit(origin, setup, 'setup (#1)')
    const after = commit(origin, files, 'push (#2)')
    return { origin, before, after }
  }

  async function planFor({ origin, before, after }) {
    const cwd = shallowCheckout(origin, after)
    git(cwd, 'fetch', '-q', '--depth=1', 'origin', before)
    return planLint({ base: before, head: after, cwd })
  }

  // The workflow's two steps: plan into a file, then lint from it, with stdout and the summary captured.
  async function runWorkflow({ origin, before, after }, api = async () => []) {
    const cwd = shallowCheckout(origin, after)
    const env = {
      GITHUB_EVENT_NAME: 'push',
      BEFORE_SHA: before,
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_STEP_SUMMARY: scratchFile('summary.md'),
      GITHUB_OUTPUT: scratchFile('output.txt'),
      MAIN_PUSH_LINT_PLAN: scratchFile('plan.json')
    }
    const out = []
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk) => out.push(String(chunk)))
    let planExit
    let lintExit = null
    try {
      planExit = await plan({ env, root: cwd })
      const gated = existsSync(env.GITHUB_OUTPUT) && readFileSync(env.GITHUB_OUTPUT, 'utf8')
      if (gated === 'lint=true\n') {
        lintExit = await lint({ env, root: cwd, api, invocationRoot: REPO_ROOT })
      }
    } finally {
      write.mockRestore()
    }
    return {
      planExit,
      lintExit,
      output: existsSync(env.GITHUB_OUTPUT) ? readFileSync(env.GITHUB_OUTPUT, 'utf8') : '',
      log: out.join(''),
      summary: existsSync(env.GITHUB_STEP_SUMMARY)
        ? readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')
        : ''
    }
  }

  return { ...gitFixture, push, planFor, runWorkflow }
}
