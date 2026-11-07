import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import {
  COMMENT_MARKER,
  COMPLIANCE_LABEL,
  ENFORCEMENT_START,
  ISSUE_TEMPLATES,
  decideIssueTemplateAction,
  evaluateIssueTemplateCompliance,
  parseIssueFormSections,
  renderComplianceComment
} from '../../.github/scripts/issue-template-compliance.mjs'

const projectDir = resolve(import.meta.dirname, '../..')
const templateDir = join(projectDir, '.github/ISSUE_TEMPLATE')
const scriptPath = join(projectDir, '.github/scripts/issue-template-compliance.mjs')
const workflow = parse(
  readFileSync(join(projectDir, '.github/workflows/issue-template-compliance.yml'), 'utf8')
)

const bugBody = [
  '### Operating system',
  '',
  'macOS',
  '',
  '### Orca version',
  '',
  '_No response_',
  '',
  '### Details',
  '',
  'Orca crashes when opening a worktree.',
  ''
].join('\n')

const featureBody = [
  '### Problem or use case',
  '',
  'Switching repositories is slow.',
  '',
  '### Proposed solution',
  '',
  'Pin repositories on the home screen.',
  '',
  '### Alternatives or additional context',
  '',
  '_No response_'
].join('\n')

const issueEvent = (action, body, overrides = {}) => ({
  action,
  issue: { number: 1, body, labels: [], user: { login: 'someone', type: 'User' }, ...overrides }
})

describe('ISSUE_TEMPLATES stays in sync with .github/ISSUE_TEMPLATE', () => {
  it('lists every form with exactly its required field labels', () => {
    const forms = readdirSync(templateDir).filter((name) => name !== 'config.yml')
    const expected = forms.map((file) => {
      const form = parse(readFileSync(join(templateDir, file), 'utf8'))
      return {
        file,
        name: form.name,
        requiredFields: form.body
          .filter((field) => field.type !== 'markdown' && field.validations?.required)
          .map((field) => field.attributes.label)
      }
    })
    expect([...ISSUE_TEMPLATES].sort((a, b) => a.file.localeCompare(b.file))).toEqual(
      expected.sort((a, b) => a.file.localeCompare(b.file))
    )
  })

  it('keeps blank issues disabled so the chooser is the only UI path', () => {
    expect(parse(readFileSync(join(templateDir, 'config.yml'), 'utf8'))).toEqual({
      blank_issues_enabled: false
    })
  })
})

describe('parseIssueFormSections', () => {
  it('maps headings to trimmed values and treats _No response_ as empty', () => {
    const sections = parseIssueFormSections(bugBody)
    expect([...sections.keys()]).toEqual(['Operating system', 'Orca version', 'Details'])
    expect(sections.get('Operating system')).toBe('macOS')
    expect(sections.get('Orca version')).toBe('')
    expect(sections.get('Details')).toBe('Orca crashes when opening a worktree.')
  })

  it('ignores headings inside fenced code blocks and CRLF line endings', () => {
    const body = '### Details\r\n\r\n```\r\n### Operating system\r\nnot a heading\r\n```\r\n'
    const sections = parseIssueFormSections(body)
    expect([...sections.keys()]).toEqual(['Details'])
    expect(sections.get('Details')).toContain('### Operating system')
  })

  it('does not let a tilde line close a backtick fence', () => {
    const body = [
      '### Details',
      '',
      '```',
      '~~~',
      '### Operating system',
      'still inside the block',
      '```',
      '',
      '### Orca version',
      '',
      '1.0.0'
    ].join('\n')
    const sections = parseIssueFormSections(body)
    expect([...sections.keys()]).toEqual(['Details', 'Orca version'])
    expect(sections.get('Details')).toContain('### Operating system')
  })

  it('requires the closing fence to be at least as long as the opening one', () => {
    const body = '### Details\n\n````\n```\n### Operating system\n````\n'
    expect([...parseIssueFormSections(body).keys()]).toEqual(['Details'])
  })

  it('handles null, empty and heading-less bodies', () => {
    expect(parseIssueFormSections(null).size).toBe(0)
    expect(parseIssueFormSections('').size).toBe(0)
    expect(parseIssueFormSections('## Steps\n1. do a thing').size).toBe(0)
  })
})

describe('evaluateIssueTemplateCompliance', () => {
  it('accepts a fully filled bug report and feature request', () => {
    expect(evaluateIssueTemplateCompliance(bugBody)).toEqual({
      compliant: true,
      template: 'Bug report',
      missingFields: []
    })
    expect(evaluateIssueTemplateCompliance(featureBody)).toEqual({
      compliant: true,
      template: 'Feature request',
      missingFields: []
    })
  })

  it('flags a bug report whose required field was blanked out', () => {
    const body = bugBody.replace('Orca crashes when opening a worktree.', '_No response_')
    expect(evaluateIssueTemplateCompliance(body)).toEqual({
      compliant: false,
      template: 'Bug report',
      missingFields: ['Details']
    })
  })

  it('flags a partially copied template, naming the missing sections', () => {
    expect(evaluateIssueTemplateCompliance('### Problem or use case\n\nI want X.')).toEqual({
      compliant: false,
      template: 'Feature request',
      missingFields: ['Proposed solution']
    })
  })

  it('flags a free-form body with no recognizable template', () => {
    expect(evaluateIssueTemplateCompliance('it broke, please fix')).toEqual({
      compliant: false,
      template: null,
      missingFields: []
    })
    expect(evaluateIssueTemplateCompliance(null).compliant).toBe(false)
  })

  it('prefers the bug form over the other form when both share a Details section', () => {
    // Bug report and Other both require "Details"; the OS field disambiguates.
    expect(evaluateIssueTemplateCompliance('### Details\n\nSomething').template).toBe('Other')
    expect(evaluateIssueTemplateCompliance(bugBody).template).toBe('Bug report')
  })
})

describe('decideIssueTemplateAction', () => {
  it('flags a newly opened issue that skipped the template', () => {
    expect(decideIssueTemplateAction(issueEvent('opened', 'help'))).toEqual({
      kind: 'flag',
      template: null,
      missingFields: []
    })
  })

  it('skips compliant, bot-authored and pull-request payloads', () => {
    expect(decideIssueTemplateAction(issueEvent('opened', bugBody)).kind).toBe('skip')
    expect(
      decideIssueTemplateAction(
        issueEvent('opened', 'x', { user: { login: 'dependabot[bot]', type: 'Bot' } })
      ).kind
    ).toBe('skip')
    expect(
      decideIssueTemplateAction(issueEvent('opened', 'x', { pull_request: { url: 'u' } })).kind
    ).toBe('skip')
    expect(decideIssueTemplateAction({ action: 'opened' }).kind).toBe('skip')
  })

  it('leaves edits to pre-enforcement, never-flagged issues alone', () => {
    // Why: pre-enforcement issues were written by hand; editing one must not retroactively flag it.
    const created_at = new Date(Date.parse(ENFORCEMENT_START) - 1000).toISOString()
    expect(
      decideIssueTemplateAction(issueEvent('edited', 'old hand-written report', { created_at }))
    ).toEqual({
      kind: 'skip',
      reason: 'edited issue predates template enforcement'
    })
  })

  it('flags an edited post-enforcement issue whose opened run never labelled it', () => {
    // Why: `cancel-in-progress` can kill the `opened` run before it adds the label.
    const created_at = new Date(Date.parse(ENFORCEMENT_START) + 1000).toISOString()
    const event = issueEvent('edited', 'help', { created_at })
    expect(decideIssueTemplateAction(event).kind).toBe('flag')
    // A missing created_at must not become an escape hatch either.
    expect(decideIssueTemplateAction(issueEvent('edited', 'help')).kind).toBe('flag')
  })

  it('clears a flagged issue once its edit makes it compliant, and re-flags otherwise', () => {
    const flagged = { labels: [{ name: COMPLIANCE_LABEL }, 'bug'] }
    expect(decideIssueTemplateAction(issueEvent('edited', bugBody, flagged))).toEqual({
      kind: 'clear',
      template: 'Bug report'
    })
    expect(decideIssueTemplateAction(issueEvent('edited', 'still nothing', flagged)).kind).toBe(
      'flag'
    )
  })

  it('ignores actions the workflow does not subscribe to', () => {
    expect(decideIssueTemplateAction(issueEvent('reopened', 'x')).kind).toBe('skip')
  })
})

describe('renderComplianceComment', () => {
  it('carries the dedupe marker, the chooser link and the missing sections', () => {
    const comment = renderComplianceComment(
      { kind: 'flag', template: 'Bug report', missingFields: ['Details'] },
      'stablyai/orca'
    )
    expect(comment.startsWith(COMMENT_MARKER)).toBe(true)
    expect(comment).toContain('https://github.com/stablyai/orca/issues/new/choose')
    expect(comment).toContain('**Bug report**')
    expect(comment).toContain('- Details')
    expect(comment).toContain(`\`${COMPLIANCE_LABEL}\``)
  })

  it('explains the no-template case without listing sections', () => {
    const comment = renderComplianceComment(
      { kind: 'flag', template: null, missingFields: [] },
      'o/r'
    )
    expect(comment).toContain('third-party client')
    expect(comment).not.toMatch(/^- /m)
  })
})

describe('CLI entrypoint', () => {
  const tempDirs = []
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function runScript(event) {
    const dir = mkdtempSync(join(tmpdir(), 'issue-template-compliance-'))
    tempDirs.push(dir)
    const eventPath = join(dir, 'event.json')
    const outputPath = join(dir, 'output.txt')
    writeFileSync(eventPath, JSON.stringify(event))
    writeFileSync(outputPath, '')
    const stdout = execFileSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: 'o/r'
      }
    })
    return { stdout, output: readFileSync(outputPath, 'utf8') }
  }

  it('writes the decision and a multi-line comment to GITHUB_OUTPUT', () => {
    const { stdout, output } = runScript(issueEvent('opened', 'nope'))
    expect(stdout).toContain('Issue #1: flag')
    expect(output).toMatch(/^kind<<EOF_kind_\d+\nflag\nEOF_kind_\d+\n/m)
    expect(output).toContain(`label<<EOF_label_`)
    expect(output).toContain(`\n${COMPLIANCE_LABEL}\n`)
    expect(output).toContain(COMMENT_MARKER)
    expect(output).toContain('https://github.com/o/r/issues/new/choose')
  })

  it('emits an empty comment for compliant issues', () => {
    const { output } = runScript(issueEvent('opened', bugBody))
    expect(output).toMatch(/^kind<<EOF_kind_\d+\nskip\n/m)
    expect(output).toMatch(/^comment<<EOF_comment_(\d+)\n\nEOF_comment_\1\n/m)
  })
})

describe('issue-template-compliance workflow contract', () => {
  const steps = workflow.jobs.check.steps
  const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout'))
  const decision = steps.find((step) => step.id === 'decision')

  it('reacts only to issue opened and edited events with issue-write scope', () => {
    expect(workflow.on).toEqual({ issues: { types: ['opened', 'edited'] } })
    expect(workflow.permissions).toEqual({ contents: 'read', issues: 'write' })
    expect(workflow.concurrency.group).toContain('github.event.issue.number')
  })

  it('checks out only the reviewed script, without persisting credentials or installing deps', () => {
    expect(checkout.with['persist-credentials']).toBe(false)
    expect(checkout.with['sparse-checkout']).toBe('.github/scripts/issue-template-compliance.mjs')
    expect(
      steps.some(
        (step) => step.uses?.includes('install-node-dependencies') || /pnpm/.test(step.run ?? '')
      )
    ).toBe(false)
    expect(decision.run).toBe('node .github/scripts/issue-template-compliance.mjs')
  })

  it('gates every gh call on the script decision and never closes the issue', () => {
    const actors = steps.filter((step) => /\bgh /.test(step.run ?? ''))
    expect(actors.map((step) => step.if)).toEqual([
      "steps.decision.outputs.kind == 'flag'",
      "steps.decision.outputs.kind == 'clear'"
    ])
    for (const step of actors) {
      expect(step.run).not.toMatch(/gh issue close|--state/)
      expect(step.env.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}')
    }
    // Why: comment text flows through env, never interpolated into the shell script.
    expect(actors[0].run).not.toContain('${{')
    // Why: piping the lookup into `grep` would read a failed `gh issue view` as "no marker".
    expect(actors[0].run).not.toMatch(/gh issue view[^\n]*\|/)
    expect(actors[0].run).toContain('grep -qF "$MARKER" <<<"$comments"')
  })
})
