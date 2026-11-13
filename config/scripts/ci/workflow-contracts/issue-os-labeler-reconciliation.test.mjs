import { expect, it } from 'vitest'
import {
  ISSUE_NUMBER,
  createFakeIssue,
  renderBugBody,
  runLabelerScript
} from './issue-os-labeler-script-runner.mjs'

const WHERE = 'Where were you using Orca?'
const OS = 'Operating system'
const MOBILE = renderBugBody({ [WHERE]: 'Mobile app', [OS]: 'iOS' })
const DESKTOP = renderBugBody({ [WHERE]: 'Desktop only', [OS]: 'macOS' })
const LINUX = renderBugBody({ [WHERE]: 'Desktop only', [OS]: 'Linux' })

const methods = (issue) => issue.calls.map((call) => call.method)
const writes = (issue) =>
  issue.writes().map(({ method, args }) => [method, args.labels ?? args.name])
const apiError = (status) => Object.assign(new Error(`HTTP ${status}`), { status })
const failure = (pattern) => ({ message: expect.stringMatching(pattern) })

it('addresses every call to the event issue and verifies with a final read', async () => {
  const issue = createFakeIssue({ body: DESKTOP, labels: ['bug', 'os:mobile', 'mobile'] })
  await runLabelerScript(issue)

  const target = { owner: 'owner', repo: 'repo', issue_number: ISSUE_NUMBER }
  expect(issue.calls.map(({ method, args }) => [method, args])).toEqual([
    ['get', target],
    ['addLabels', { ...target, labels: ['os:macos'] }],
    ['removeLabel', { ...target, name: 'os:mobile' }],
    ['removeLabel', { ...target, name: 'mobile' }],
    ['get', target]
  ])
  expect(issue.labels).toEqual(['bug', 'os:macos'])
})

it('ignores the webhook snapshot when a stale older event runs after a newer one', async () => {
  const issue = createFakeIssue({ body: DESKTOP, labels: ['bug', 'os:mobile', 'mobile'] })
  const newerPayload = { number: ISSUE_NUMBER, body: DESKTOP, labels: [{ name: 'bug' }] }
  const stalePayload = {
    number: ISSUE_NUMBER,
    body: LINUX,
    labels: [{ name: 'bug' }, { name: 'wontfix' }]
  }

  await runLabelerScript(issue, { payloadIssue: newerPayload })
  expect(issue.labels).toEqual(['bug', 'os:macos'])

  const writesBefore = issue.writes().length
  await runLabelerScript(issue, { payloadIssue: stalePayload })
  expect(issue.labels).toEqual(['bug', 'os:macos'])
  expect(issue.writes()).toHaveLength(writesBefore)
})

it('is idempotent across repeated events', async () => {
  const issue = createFakeIssue({ body: MOBILE, labels: ['bug'] })
  await runLabelerScript(issue)
  await runLabelerScript(issue)
  await runLabelerScript(issue)

  expect(issue.labels).toEqual(['bug', 'os:mobile', 'mobile'])
  expect(writes(issue)).toEqual([['addLabels', ['os:mobile', 'mobile']]])
  expect(methods(issue)).toEqual(['get', 'addLabels', 'get', 'get', 'get'])
})

it('retries against the fresh form when the body changes during mutation', async () => {
  const issue = createFakeIssue({ body: MOBILE, labels: ['bug', 'os:Windows'] })
  issue.onCall = (call) => {
    if (call.method === 'removeLabel' && call.args.name === 'os:Windows') {
      issue.body = DESKTOP
    }
  }
  await runLabelerScript(issue)

  expect(issue.labels).toEqual(['bug', 'os:macos'])
  expect(writes(issue)).toEqual([
    ['addLabels', ['os:mobile', 'mobile']],
    ['removeLabel', 'os:Windows'],
    ['addLabels', ['os:macos']],
    ['removeLabel', 'os:mobile'],
    ['removeLabel', 'mobile']
  ])
})

it('keeps unrelated labels that appear between its read and its writes', async () => {
  const issue = createFakeIssue({ body: DESKTOP, labels: ['bug', 'os:mobile', 'mobile'] })
  issue.onCall = (call) => {
    if (call.method !== 'get' && !issue.labels.includes('needs-repro')) {
      issue.labels.push('needs-repro')
    }
    if (call.method === 'removeLabel' && call.args.name === 'mobile') {
      issue.labels.push('priority:high')
    }
  }
  await runLabelerScript(issue)

  expect(issue.labels).toEqual(['bug', 'needs-repro', 'os:macos', 'priority:high'])
})

it('re-adds a desired managed label that someone removes during the run', async () => {
  const issue = createFakeIssue({ body: MOBILE, labels: ['bug', 'os:linux'] })
  let removedOnce = false
  issue.onCall = (call) => {
    if (call.method === 'removeLabel' && !removedOnce) {
      removedOnce = true
      issue.labels = issue.labels.filter((label) => label !== 'mobile')
    }
  }
  await runLabelerScript(issue)

  expect(issue.labels).toEqual(['bug', 'os:mobile', 'mobile'])
  expect(writes(issue)).toEqual([
    ['addLabels', ['os:mobile', 'mobile']],
    ['removeLabel', 'os:linux'],
    ['addLabels', ['mobile']]
  ])
})

it('tolerates 404 when a managed label was already removed', async () => {
  const issue = createFakeIssue({ body: DESKTOP, labels: ['bug', 'os:mobile', 'mobile'] })
  issue.onCall = (call) => {
    if (call.method === 'removeLabel' && call.args.name === 'os:mobile') {
      issue.labels = issue.labels.filter((label) => label !== 'os:mobile')
    }
  }
  await runLabelerScript(issue)

  expect(issue.labels).toEqual(['bug', 'os:macos'])
  expect(methods(issue)).toEqual(['get', 'addLabels', 'removeLabel', 'removeLabel', 'get'])
})

it('does not report success when the issue disappears mid-run', async () => {
  const issue = createFakeIssue({ body: DESKTOP, labels: ['bug', 'os:mobile'] })
  issue.onCall = (call) => {
    if (call.method === 'removeLabel') {
      issue.deleted = true
    }
  }
  await expect(runLabelerScript(issue)).rejects.toMatchObject({ status: 404 })
  expect(methods(issue)).toEqual(['get', 'addLabels', 'removeLabel', 'get'])
})

it.each([
  ['get', 500, ['get']],
  ['addLabels', 404, ['get', 'addLabels']],
  ['removeLabel', 403, ['get', 'addLabels', 'removeLabel']]
])('fails the job when %s returns %i', async (method, status, expectedCalls) => {
  const issue = createFakeIssue({ body: DESKTOP, labels: ['bug', 'os:mobile', 'mobile'] })
  issue.onCall = (call) => {
    if (call.method === method) {
      throw apiError(status)
    }
  }
  await expect(runLabelerScript(issue)).rejects.toMatchObject({ status })
  expect(methods(issue)).toEqual(expectedCalls)
  expect(issue.labels).toContain('bug')
})

it('fails with a rerun hint after three passes of a continuously edited issue', async () => {
  const issue = createFakeIssue({ body: MOBILE, labels: ['bug', 'keep'] })
  const bodies = [DESKTOP, LINUX, MOBILE, DESKTOP, LINUX]
  issue.onCall = (call) => {
    if (call.method === 'addLabels') {
      issue.body = bodies.shift()
    }
  }
  await expect(runLabelerScript(issue)).rejects.toMatchObject(failure(/after 3 passes/))

  expect(issue.calls.filter((call) => call.method === 'addLabels')).toHaveLength(3)
  expect(issue.calls.filter((call) => call.method === 'get')).toHaveLength(4)
  expect(methods(issue).at(-1)).toBe('get')
  expect(issue.labels).toEqual(expect.arrayContaining(['bug', 'keep']))
})

it('succeeds on the third pass when the issue settles', async () => {
  const issue = createFakeIssue({ body: MOBILE, labels: ['bug'] })
  const bodies = [DESKTOP, LINUX]
  issue.onCall = (call) => {
    if (call.method === 'addLabels' && bodies.length > 0) {
      issue.body = bodies.shift()
    }
  }
  await runLabelerScript(issue)
  expect(issue.labels).toEqual(['bug', 'os:linux'])
})

it('stops and fails when the body stops being a bug form after a write', async () => {
  const issue = createFakeIssue({ body: DESKTOP, labels: ['bug', 'os:mobile', 'mobile'] })
  issue.onCall = (call) => {
    if (call.method === 'removeLabel' && call.args.name === 'os:mobile') {
      issue.body = 'Rewritten as free text.'
    }
  }
  await expect(runLabelerScript(issue)).rejects.toMatchObject(
    failure(/stopped matching the bug form/)
  )

  // Writes already issued in that pass complete; nothing further is attempted or rolled back.
  expect(methods(issue)).toEqual(['get', 'addLabels', 'removeLabel', 'removeLabel', 'get'])
  expect(issue.labels).toEqual(['bug', 'os:macos'])
})

it('treats an unrecognized body as a successful no-op before any write', async () => {
  const issue = createFakeIssue({
    body: 'Just a question.',
    labels: ['bug', 'os:mobile', 'mobile']
  })
  await runLabelerScript(issue, {
    payloadIssue: { number: ISSUE_NUMBER, body: DESKTOP, labels: [] }
  })

  expect(methods(issue)).toEqual(['get'])
  expect(issue.labels).toEqual(['bug', 'os:mobile', 'mobile'])
})
