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
  const warnings = []
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
    core: { info: () => {}, warning: (message) => warnings.push(message) }
  })
  return { labels: issue.labels.sort(), warnings }
}

// The bug form as GitHub renders it; a skipped optional dropdown shows as "None".
function bugBody({ where, os, remote }) {
  return (
    `### Where were you using Orca?\n\n${where}\n\n### Operating system\n\n${os}\n\n` +
    `### Remote host operating system\n\n${remote}\n\n### Orca version\n\n_No response_\n\n` +
    '### Details\n\nIt broke.'
  )
}

it('labels a mobile app issue whose remote host operating system was left unselected', async () => {
  const body = bugBody({ where: 'Mobile app', os: 'iOS', remote: 'None' })

  expect((await labelIssue(body, ['bug'])).labels).toEqual(['bug', 'mobile', 'os:mobile'])
})

it('keeps the OS label when the required operating system is edited to None', async () => {
  const body = bugBody({ where: 'Desktop only', os: 'None', remote: 'None' })

  expect((await labelIssue(body, ['bug', 'os:macos'])).labels).toEqual(['bug', 'os:macos'])
})

it('keeps the mobile label when the required location is edited to None', async () => {
  const body = bugBody({ where: 'None', os: 'iOS', remote: 'None' })

  expect((await labelIssue(body, ['bug', 'mobile', 'os:mobile'])).labels).toEqual([
    'bug',
    'mobile',
    'os:mobile'
  ])
})

it('keeps labels and warns when a choice is not one the form offers', async () => {
  const body = bugBody({ where: 'Desktop + SSH host', os: 'macOS', remote: 'Solaris' })

  const { labels, warnings } = await labelIssue(body, ['bug', 'os:linux'])

  expect(labels).toEqual(['bug', 'os:linux'])
  expect(warnings).toEqual([expect.stringMatching(/Remote host operating system.*solaris/)])
})
