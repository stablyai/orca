import { expect, it } from 'vitest'
import {
  createFakeIssue,
  renderBugBody,
  runLabelerScript
} from './issue-os-labeler-script-runner.mjs'

const WHERE = 'Where were you using Orca?'
const OS = 'Operating system'
const MOBILE = renderBugBody({ [WHERE]: 'Mobile app', [OS]: 'iOS' })
const DESKTOP = renderBugBody({ [WHERE]: 'Desktop only', [OS]: 'macOS' })

it('retries against the fresh form when the body changes during mutation', async () => {
  const issue = createFakeIssue({ body: MOBILE, labels: ['bug', 'os:Windows'] })
  issue.onCall = (call) => {
    if (call.method === 'removeLabel' && call.args.name === 'os:Windows') {
      issue.body = DESKTOP
    }
  }
  await runLabelerScript(issue)

  expect(issue.labels).toEqual(['bug', 'os:macos'])
})
