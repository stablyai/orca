import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

const labelerScript = parse(readFileSync('.github/workflows/issue-os-labeler.yaml', 'utf8')).jobs[
  'apply-os-label'
].steps[0].with.script

// Runs the workflow script as actions/github-script does, against an in-memory issue.
async function labelIssue(body, labels) {
  const issue = { number: 1, body, labels: [...labels] }
  const issues = {
    get: async () => ({
      data: { body: issue.body, labels: issue.labels.map((name) => ({ name })) }
    }),
    addLabels: async ({ labels: added }) => {
      issue.labels = [...new Set([...issue.labels, ...added])]
    },
    removeLabel: async ({ name }) => {
      issue.labels = issue.labels.filter((label) => label !== name)
    }
  }
  await runInNewContext(`(async () => { ${labelerScript}\n})()`, {
    context: { repo: { owner: 'o', repo: 'r' }, payload: { issue: { number: 1 } } },
    github: { rest: { issues } },
    core: { info: () => {}, warning: () => {} }
  })
  return issue.labels.sort()
}

// Bodies as GitHub rendered them on real issues where the optional remote host was skipped.
it('labels a desktop issue whose remote host operating system was left unselected', async () => {
  const body =
    '### Where were you using Orca?\n\nDesktop only\n\n### Operating system\n\nWindows\n\n' +
    '### Remote host operating system\n\nNone\n\n### Orca version\n\n_No response_\n\n' +
    '### Details\n\nRemoving worktree stuck.'

  expect(await labelIssue(body, ['bug'])).toEqual(['bug', 'os:Windows'])
})

it('labels a mobile app issue whose remote host operating system was left unselected', async () => {
  const body =
    '### Where were you using Orca?\n\nMobile app\n\n### Operating system\n\niOS\n\n' +
    '### Remote host operating system\n\nNone\n\n### Orca version\n\n0.0.63\n\n' +
    '### Details\n\nThe line-wrap button is not working.'

  expect(await labelIssue(body, ['bug'])).toEqual(['bug', 'mobile', 'os:mobile'])
})
