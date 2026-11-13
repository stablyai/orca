import { describe, expect, it } from 'vitest'
import {
  MANAGED_LABELS,
  bugForm,
  labelIssue,
  readIssueForm,
  renderBugBody,
  renderFormBody,
  renderSections
} from './issue-os-labeler-script-runner.mjs'

const WHERE = 'Where were you using Orca?'
const OS = 'Operating system'
const REMOTE_OS = 'Remote host operating system'
const UNRELATED = ['bug', 'needs-triage']
const STALE = [...UNRELATED, ...MANAGED_LABELS]

const optionsOf = (id) => bugForm.body.find((field) => field.id === id).attributes.options

// Reconciles from "no managed labels" and from "every managed label"; both must converge.
async function expectReconciled(body, managed) {
  const fresh = await labelIssue(body, UNRELATED)
  expect(fresh.labels).toEqual([...UNRELATED, ...managed])
  expect(fresh.writes).toEqual(managed.length > 0 ? [['addLabels', managed]] : [])

  const stale = await labelIssue(body, STALE)
  expect(stale.labels).toEqual([...UNRELATED, ...managed])
  expect(stale.writes).toEqual(
    MANAGED_LABELS.filter((label) => !managed.includes(label)).map((label) => [
      'removeLabel',
      label
    ])
  )
}

async function expectUntouched(body) {
  for (const labels of [UNRELATED, STALE]) {
    expect(await labelIssue(body, labels)).toEqual({ labels, writes: [] })
  }
}

describe('current bug form', () => {
  it('recognises every option the shipped form offers', async () => {
    // An unrecognised value leaves the issue untouched; a recognised one clears stale labels.
    for (const [id, heading] of [
      ['where', WHERE],
      ['os', OS],
      ['remote_os', REMOTE_OS]
    ]) {
      for (const option of optionsOf(id)) {
        const result = await labelIssue(renderBugBody({ [heading]: option }), STALE)
        expect(result.writes, `${heading}=${option}`).not.toEqual([])
      }
    }
  })

  it.each([
    ['Desktop only', 'macOS', ['os:macos']],
    ['Desktop + Orca server', 'Windows', ['os:Windows']],
    ['Desktop + SSH host', 'Linux', ['os:linux']],
    ['Mobile app', 'iOS', ['os:mobile', 'mobile']],
    ['Mobile app', 'Android', ['os:mobile', 'mobile']]
  ])('Where=%s, OS=%s -> %j', async (where, os, managed) => {
    await expectReconciled(renderBugBody({ [WHERE]: where, [OS]: os }), managed)
  })

  it('labels the client device, never the remote host or WSL distro', async () => {
    for (const where of ['Desktop + SSH host', 'Desktop + WSL']) {
      const body = renderBugBody({ [WHERE]: where, [OS]: 'Windows', [REMOTE_OS]: 'Linux' })
      await expectReconciled(body, ['os:Windows'])
    }
  })

  it('keeps OS and Where independent when they disagree', async () => {
    await expectReconciled(renderBugBody({ [WHERE]: 'Web browser', [OS]: 'iOS' }), ['os:mobile'])
    await expectReconciled(renderBugBody({ [WHERE]: 'Mobile app', [OS]: 'macOS' }), [
      'os:macos',
      'mobile'
    ])
  })

  it('drops mobile labels when a mobile report is edited to desktop', async () => {
    const edited = renderBugBody({ [WHERE]: 'Desktop only', [OS]: 'macOS' })
    expect(await labelIssue(edited, ['bug', 'os:mobile', 'mobile', 'needs-triage'])).toEqual({
      labels: ['bug', 'needs-triage', 'os:macos'],
      writes: [
        ['addLabels', ['os:macos']],
        ['removeLabel', 'os:mobile'],
        ['removeLabel', 'mobile']
      ]
    })
  })

  it.each([
    ['Other OS on mobile', { [WHERE]: 'Mobile app', [OS]: 'Other' }, ['mobile']],
    ['unselected Where', { [OS]: 'Linux' }, ['os:linux']],
    ['everything unselected', {}, []]
  ])('%s cleans up stale managed labels', async (_name, values, managed) => {
    await expectReconciled(renderBugBody(values), managed)
  })

  it('reads a truly empty section as unselected instead of the next heading', async () => {
    const body = `### ${WHERE}\n\n### ${OS}\n\n\n### ${REMOTE_OS}\n### Orca version\n\n### Details\n\nx`
    await expectReconciled(body, [])
  })

  it.each([
    ['CRLF line endings', (body) => body.replace(/\n/g, '\r\n')],
    ['padded and differently cased values', (body) => body.replace('Mobile app', '  MOBILE App \t')]
  ])('accepts %s', async (_name, transform) => {
    const body = transform(renderBugBody({ [WHERE]: 'Mobile app', [OS]: 'Android' }))
    await expectReconciled(body, ['os:mobile', 'mobile'])
  })
})

describe('retired option strings and headings', () => {
  it.each([
    ['current heading, retired value', WHERE, 'Mobile (Android)', OS, ['os:linux', 'mobile']],
    ['Client heading, retired value', 'Client', 'Desktop + SSH', OS, ['os:linux']],
    [
      'Client heading, bare value',
      'Client',
      'Mobile',
      'Host operating system',
      ['os:linux', 'mobile']
    ]
  ])('%s keeps its meaning', async (_name, whereHeading, where, osHeading, managed) => {
    const body = renderSections([
      [whereHeading, where],
      [osHeading, 'Linux'],
      ['Orca version', ''],
      ['Details', 'x']
    ])
    await expectReconciled(body, managed)
  })

  it('does not accept bare Mobile under the current Where heading', async () => {
    await expectUntouched(renderBugBody({ [WHERE]: 'Mobile', [OS]: 'Linux' }))
  })

  it.each([
    [
      'form on main',
      [
        [OS, 'Windows'],
        ['Orca version', 'v1.4.2'],
        ['Details', 'x']
      ]
    ],
    [
      'first form, ending at Reproduction steps',
      [
        ['Summary', 'Crash on launch'],
        [OS, 'Windows'],
        ['Orca version', 'v0.9.0'],
        ['Coding harness and version', 'Claude Code 2.0'],
        ['Reproduction steps', `1. Open\n\n### ${OS}\n\nLinux`],
        ['Expected behavior', 'Works']
      ]
    ]
  ])('%s without a Where field gets its OS label and no mobile label', async (_name, sections) => {
    await expectReconciled(renderSections(sections), ['os:Windows'])
  })

  it('prefers the current heading by presence, even when it is blank', async () => {
    const sections = (where, os) =>
      renderSections([
        [WHERE, where],
        ['Client', 'Mobile'],
        [OS, os],
        ['Host operating system', 'Linux'],
        ['Orca version', ''],
        ['Details', 'x']
      ])
    await expectReconciled(sections('Desktop only', 'macOS'), ['os:macos'])
    await expectReconciled(sections('', ''), [])
  })

  it('accepts the legacy heading before the current one in the same group', async () => {
    const body = renderSections([
      ['Client', 'Mobile'],
      [WHERE, 'Web browser'],
      ['Host operating system', 'Linux'],
      [OS, 'Windows'],
      ['Orca version', ''],
      ['Details', 'x']
    ])
    await expectReconciled(body, ['os:Windows'])
  })
})

describe('bodies that must never change labels', () => {
  const valid = renderBugBody({ [WHERE]: 'Mobile app', [OS]: 'Linux', [REMOTE_OS]: 'Linux' })
  const fenced = `\`\`\`md\n${valid}\n\`\`\``

  it.each(['TempleOS', '__proto__', 'constructor'])(
    'unknown or prototype-named value %s in any dropdown',
    async (value) => {
      await expectUntouched(renderBugBody({ [WHERE]: 'Mobile app', [OS]: value }))
      await expectUntouched(renderBugBody({ [WHERE]: value, [OS]: 'Linux' }))
      await expectUntouched(renderBugBody({ [OS]: 'Linux', [REMOTE_OS]: value }))
      await expectUntouched(
        renderSections([
          ['Client', value],
          ['Host operating system', 'Linux'],
          ['Orca version', ''],
          ['Details', 'x']
        ])
      )
    }
  )

  it.each([
    [
      'repeated OS heading',
      valid.replace(`### ${REMOTE_OS}`, `### ${OS}\n\nmacOS\n\n### ${REMOTE_OS}`)
    ],
    [
      'unknown heading',
      valid.replace('### Orca version', '### Device model\n\nPixel\n\n### Orca version')
    ],
    [
      'OS before Where',
      renderSections([
        [OS, 'Linux'],
        [WHERE, 'Mobile app'],
        ['Orca version', ''],
        ['Details', 'x']
      ])
    ],
    ['multiline dropdown value', valid.replace(`### ${OS}\n\nLinux`, `### ${OS}\n\nLinux\nmacOS`)],
    [
      'missing free-text heading',
      renderSections([
        [WHERE, 'Mobile app'],
        [OS, 'Linux'],
        ['Orca version', '']
      ])
    ],
    ['leading prose', `Hello team,\n\n${valid}`],
    ['leading code fence', fenced]
  ])('%s', async (_name, body) => {
    await expectUntouched(body)
  })

  it('Other and Feature forms, even with a bug form pasted into their text', async () => {
    await expectUntouched(renderFormBody(readIssueForm('other'), { Details: valid }))
    await expectUntouched(
      renderFormBody(readIssueForm('feature_request'), {
        'Problem or use case': valid,
        'Proposed solution': fenced
      })
    )
  })
})

describe('free text after the metadata prefix', () => {
  it.each([
    ['conflicting form example', `### ${OS}\n\nLinux\n\n### ${WHERE}\n\nDesktop only`],
    [
      'unknown, repeated and malformed headings',
      `### Details\n\n### Device\n\n### ${OS}\nA\nB\n###`
    ]
  ])('ignores a %s in Details', async (_name, details) => {
    const body = renderBugBody({ [WHERE]: 'Mobile app', [OS]: 'Android', Details: details })
    await expectReconciled(body, ['os:mobile', 'mobile'])
  })
})
