import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { parse } from 'yaml'

export const MANAGED_LABELS = ['os:macos', 'os:Windows', 'os:linux', 'os:mobile', 'mobile']
export const ISSUE_NUMBER = 4242

const labelerScript = parse(readFileSync('.github/workflows/issue-os-labeler.yaml', 'utf8')).jobs[
  'apply-os-label'
].steps[0].with.script

export function readIssueForm(name) {
  return parse(readFileSync(`.github/ISSUE_TEMPLATE/${name}.yml`, 'utf8'))
}

export const bugForm = readIssueForm('bug_report')

// GitHub renders each non-markdown form field as "### <label>", blank line, value.
export function renderSections(sections) {
  return sections
    .map(([heading, value]) => `### ${heading}\n\n${value === '' ? '_No response_' : value}`)
    .join('\n\n')
}

function formHeadings(form) {
  return form.body
    .filter((field) => field.type !== 'markdown')
    .map((field) => field.attributes.label)
}

// Sections follow the form's real labels and order; unspecified fields are unselected.
export function renderFormBody(form, valuesByHeading = {}) {
  const headings = formHeadings(form)
  const unknown = Object.keys(valuesByHeading).filter((heading) => !headings.includes(heading))
  if (unknown.length > 0) {
    throw new Error(`Form has no field labelled: ${unknown.join(', ')}`)
  }
  return renderSections(headings.map((heading) => [heading, valuesByHeading[heading] ?? '']))
}

export function renderBugBody(values = {}) {
  return renderFormBody(bugForm, { Details: 'It broke.', ...values })
}

function notFound() {
  return Object.assign(new Error('Not Found'), { status: 404 })
}

// In-memory issue behind the REST calls the labeler may make. `onCall` runs before each call
// takes effect, so a test can edit the issue mid-run or throw to inject an API failure.
export function createFakeIssue({ body, labels = [], number = ISSUE_NUMBER }) {
  const issue = { number, body, labels: [...labels], deleted: false, calls: [], onCall: null }

  const endpoint = (method, apply) => async (args) => {
    const call = { method, args, index: issue.calls.length }
    issue.calls.push(call)
    await issue.onCall?.(call, issue)
    if (issue.deleted) {
      throw notFound()
    }
    return apply(args)
  }

  issue.rest = {
    issues: {
      get: endpoint('get', () => ({
        data: {
          number: issue.number,
          body: issue.body,
          labels: issue.labels.map((name) => ({ name }))
        }
      })),
      addLabels: endpoint('addLabels', ({ labels: added }) => {
        issue.labels = [...new Set([...issue.labels, ...added])]
        return { data: issue.labels.map((name) => ({ name })) }
      }),
      removeLabel: endpoint('removeLabel', ({ name }) => {
        if (!issue.labels.includes(name)) {
          throw notFound()
        }
        issue.labels = issue.labels.filter((label) => label !== name)
        return { data: issue.labels.map((label) => ({ name: label })) }
      }),
      setLabels: endpoint('setLabels', ({ labels: next }) => {
        issue.labels = [...new Set(next)]
        return { data: [] }
      }),
      removeAllLabels: endpoint('removeAllLabels', () => {
        issue.labels = []
        return { data: [] }
      })
    }
  }
  issue.writes = () => issue.calls.filter((call) => call.method !== 'get')
  return issue
}

// Runs a workflow script exactly as actions/github-script does: as an async function body.
export function runLabelerScript(issue, { payloadIssue } = {}) {
  const core = {
    info: () => {},
    warning: () => {},
    setFailed: (message) => {
      throw new Error(message)
    }
  }
  const context = {
    repo: { owner: 'owner', repo: 'repo' },
    payload: {
      // Webhook snapshot; defaults to the issue as it was when the run was queued.
      issue: payloadIssue ?? {
        number: issue.number,
        body: issue.body,
        labels: issue.labels.map((name) => ({ name }))
      }
    }
  }
  return runInNewContext(`(async () => { ${labelerScript}\n})()`, {
    context,
    github: { rest: issue.rest },
    core
  })
}

// Runs the labeler on a fresh issue and reports the complete outcome.
export async function labelIssue(body, labels = [], options = {}) {
  const issue = createFakeIssue({ body, labels })
  await runLabelerScript(issue, options)
  return {
    labels: issue.labels,
    writes: issue.writes().map(({ method, args }) => [method, args.labels ?? args.name])
  }
}
