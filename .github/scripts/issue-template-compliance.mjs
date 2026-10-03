import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Why hardcoded: the runner has no YAML parser without a pnpm install. The
// vitest drift guard fails whenever these diverge from .github/ISSUE_TEMPLATE.
export const ISSUE_TEMPLATES = [
  { file: 'bug_report.yml', name: 'Bug report', requiredFields: ['Operating system', 'Details'] },
  {
    file: 'feature_request.yml',
    name: 'Feature request',
    requiredFields: ['Problem or use case', 'Proposed solution']
  },
  { file: 'other.yml', name: 'Other', requiredFields: ['Details'] }
]

export const COMPLIANCE_LABEL = 'needs-template'
export const COMMENT_MARKER = '<!-- orca-issue-template-compliance -->'
// Why: GitHub renders a skipped optional form field as this literal.
const EMPTY_FIELD_VALUE = '_No response_'

// Issue forms render each field as `### <label>` followed by the value.
export function parseIssueFormSections(body) {
  const sections = new Map()
  let current = null
  // Why: a fence closes only on the same character, at least as long, with nothing trailing.
  let fence = null
  for (const rawLine of (body ?? '').split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    const delimiter = line.match(/^\s*(`{3,}|~{3,})/)?.[1]
    if (!fence) {
      fence = delimiter ?? null
    } else if (
      delimiter &&
      delimiter[0] === fence[0] &&
      delimiter.length >= fence.length &&
      line.trim() === delimiter
    ) {
      fence = null
    }
    const heading = !fence && line.match(/^### (.+)$/)
    if (heading) {
      current = heading[1].trim()
      if (!sections.has(current)) {
        sections.set(current, [])
      }
      continue
    }
    if (current) {
      sections.get(current).push(rawLine)
    }
  }
  return new Map(
    [...sections].map(([label, lines]) => {
      const value = lines.join('\n').trim()
      return [label, value === EMPTY_FIELD_VALUE ? '' : value]
    })
  )
}

export function evaluateIssueTemplateCompliance(body, templates = ISSUE_TEMPLATES) {
  const sections = parseIssueFormSections(body)
  const candidates = templates.map((template) => {
    const present = template.requiredFields.filter((field) => sections.has(field))
    const missingFields = template.requiredFields.filter((field) => !sections.get(field))
    return { template, present: present.length, missingFields }
  })
  // Why: pick the template the author most likely used, then judge its required fields.
  const best = candidates.reduce((a, b) =>
    b.present > a.present ||
    (b.present === a.present && b.missingFields.length < a.missingFields.length)
      ? b
      : a
  )
  if (best.present === 0) {
    return { compliant: false, template: null, missingFields: [] }
  }
  return {
    compliant: best.missingFields.length === 0,
    template: best.template.name,
    missingFields: best.missingFields
  }
}

function hasComplianceLabel(issue) {
  return (issue.labels ?? []).some(
    (label) => (typeof label === 'string' ? label : label.name) === COMPLIANCE_LABEL
  )
}

// Why hardcoded: the moment this workflow landed. Issues filed earlier were written
// before the forms were mandatory, so editing one must not retroactively flag it.
export const ENFORCEMENT_START = '2026-09-07T16:27:44Z'

// Why created_at, not label presence: `cancel-in-progress` can kill the `opened`
// run mid-flight, leaving a brand-new non-compliant issue unlabeled.
function predatesEnforcement(issue) {
  const createdAt = Date.parse(issue.created_at ?? '')
  return Number.isFinite(createdAt) && createdAt < Date.parse(ENFORCEMENT_START)
}

// Returns what the workflow should do; performing it stays in the workflow.
export function decideIssueTemplateAction(event, templates = ISSUE_TEMPLATES) {
  const { action, issue } = event
  if (!issue) {
    return { kind: 'skip', reason: 'no issue in event payload' }
  }
  if (issue.pull_request) {
    return { kind: 'skip', reason: 'pull requests are not checked' }
  }
  if (issue.user?.type === 'Bot') {
    return { kind: 'skip', reason: `bot author ${issue.user.login}` }
  }
  const flagged = hasComplianceLabel(issue)
  if (action === 'edited' && !flagged && predatesEnforcement(issue)) {
    return { kind: 'skip', reason: 'edited issue predates template enforcement' }
  }
  if (action !== 'opened' && action !== 'edited') {
    return { kind: 'skip', reason: `unhandled action ${action}` }
  }
  const result = evaluateIssueTemplateCompliance(issue.body, templates)
  if (result.compliant) {
    return flagged
      ? { kind: 'clear', template: result.template }
      : { kind: 'skip', reason: 'compliant' }
  }
  return { kind: 'flag', template: result.template, missingFields: result.missingFields }
}

export function renderComplianceComment(decision, repository) {
  const chooser = `https://github.com/${repository}/issues/new/choose`
  const detail = decision.template
    ? `It looks like the **${decision.template}** form, but these required sections are empty or missing:\n\n${decision.missingFields.map((field) => `- ${field}`).join('\n')}`
    : 'It does not contain any of the sections from our issue forms, so it was probably filed without one (for example through the API or a third-party client).'
  return [
    COMMENT_MARKER,
    'Thanks for the report! This issue was not filed with one of our issue templates, so it is missing information maintainers need to act on it.',
    '',
    detail,
    '',
    `Please edit the issue body to follow the matching template from ${chooser}. The \`${COMPLIANCE_LABEL}\` label is removed automatically once the required sections are filled in.`
  ].join('\n')
}

function writeOutputs(outputs) {
  const target = process.env.GITHUB_OUTPUT
  const lines = Object.entries(outputs).map(([key, value]) => {
    const delimiter = `EOF_${key}_${process.pid}`
    return `${key}<<${delimiter}\n${value}\n${delimiter}\n`
  })
  if (!target) {
    process.stdout.write(lines.join(''))
    return
  }
  appendFileSync(target, lines.join(''))
}

function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH
  if (!eventPath) {
    console.error('GITHUB_EVENT_PATH is not set')
    return 2
  }
  const event = JSON.parse(readFileSync(eventPath, 'utf8'))
  const decision = decideIssueTemplateAction(event)
  console.log(
    `Issue #${event.issue?.number}: ${decision.kind}${decision.reason ? ` (${decision.reason})` : ''}`
  )
  writeOutputs({
    kind: decision.kind,
    label: COMPLIANCE_LABEL,
    marker: COMMENT_MARKER,
    comment:
      decision.kind === 'flag'
        ? renderComplianceComment(decision, process.env.GITHUB_REPOSITORY ?? '')
        : ''
  })
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main()
}
