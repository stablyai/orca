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
const OS_LABEL = {
  macOS: 'os:macos',
  Windows: 'os:Windows',
  Linux: 'os:linux',
  iOS: 'os:mobile',
  Android: 'os:mobile',
  Other: null
}
const MOBILE_WHERE = new Set(['Mobile app', 'Mobile (iOS)', 'Mobile (Android)', 'Mobile'])
const RETIRED_WHERE = [
  'Desktop (this computer)',
  'Desktop + SSH',
  'Desktop + Orca remote server',
  'Desktop + WSL',
  'Mobile (iOS)',
  'Mobile (Android)',
  'Web / browser',
  'Other'
]

function expectedManaged(where, os) {
  return MANAGED_LABELS.filter(
    (label) => label === OS_LABEL[os] || (label === 'mobile' && MOBILE_WHERE.has(where))
  )
}

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
  const combinations = optionsOf('where').flatMap((where) =>
    optionsOf('os').map((os) => [where, os, expectedManaged(where, os)])
  )

  it('covers every documented Where and OS option', () => {
    expect(optionsOf('where')).toHaveLength(7)
    expect(Object.keys(OS_LABEL)).toEqual(optionsOf('os'))
  })

  it.each(combinations)('Where=%s, OS=%s -> %j', async (where, os, managed) => {
    await expectReconciled(renderBugBody({ [WHERE]: where, [OS]: os }), managed)
  })

  it.each(['', ...optionsOf('remote_os')])(
    'remote host OS %j never supplies a client label',
    async (remoteOs) => {
      for (const where of ['Desktop + SSH host', 'Desktop + Orca server', 'Web browser']) {
        const body = renderBugBody({ [WHERE]: where, [OS]: 'Windows', [REMOTE_OS]: remoteOs })
        await expectReconciled(body, ['os:Windows'])
      }
    }
  )

  it('labels WSL by the Windows device, not the Linux distro', async () => {
    const body = renderBugBody({ [WHERE]: 'Desktop + WSL', [OS]: 'Windows', [REMOTE_OS]: 'Linux' })
    await expectReconciled(body, ['os:Windows'])
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
    ['Other OS', { [WHERE]: 'Web browser', [OS]: 'Other' }, []],
    ['Other OS on mobile', { [WHERE]: 'Mobile app', [OS]: 'Other' }, ['mobile']],
    ['unselected OS', { [WHERE]: 'Mobile app' }, ['mobile']],
    ['unselected Where', { [OS]: 'Linux' }, ['os:linux']],
    ['everything unselected', {}, []],
    ['Other everywhere', { [WHERE]: 'Other', [OS]: 'Other', [REMOTE_OS]: 'Other' }, []]
  ])('%s cleans up stale managed labels', async (_name, values, managed) => {
    await expectReconciled(renderBugBody(values), managed)
  })

  it('reads a truly empty section as unselected instead of the next heading', async () => {
    const body = `### ${WHERE}\n\n### ${OS}\n\n\n### ${REMOTE_OS}\n### Orca version\n\n### Details\n\nx`
    await expectReconciled(body, [])
  })

  it.each([
    ['CRLF line endings', (body) => body.replace(/\n/g, '\r\n')],
    ['leading blank lines', (body) => `\n \t\n\n${body}`],
    ['padded and differently cased values', (body) => body.replace('Mobile app', '  MOBILE App \t')]
  ])('accepts %s', async (_name, transform) => {
    const body = transform(renderBugBody({ [WHERE]: 'Mobile app', [OS]: 'Android' }))
    await expectReconciled(body, ['os:mobile', 'mobile'])
  })
})

describe('retired option strings and headings', () => {
  it.each(RETIRED_WHERE.flatMap((where) => [WHERE, 'Client'].map((heading) => [heading, where])))(
    '%s=%s keeps its meaning',
    async (heading, where) => {
      const body = renderSections([
        [heading, where],
        [OS, 'Linux'],
        ['Orca version', ''],
        ['Details', 'x']
      ])
      await expectReconciled(body, expectedManaged(where, 'Linux'))
    }
  )

  it.each(['Desktop', 'Mobile', 'Web'])('Client=%s is accepted', async (client) => {
    const body = renderSections([
      ['Client', client],
      ['Host operating system', 'Windows'],
      ['Orca version', 'v1.4.2'],
      ['Details', 'x']
    ])
    await expectReconciled(body, expectedManaged(client, 'Windows'))
  })

  it.each(['Desktop', 'Mobile', 'Web'])(
    'bare %s is not a Where option outside the Client heading',
    async (value) => {
      await expectUntouched(renderBugBody({ [WHERE]: value, [OS]: 'macOS' }))
    }
  )

  it.each([
    [
      'first form',
      [
        ['Summary', 'Crash on launch'],
        [OS, 'Windows'],
        ['Orca version', 'v0.9.0'],
        ['Coding harness and version', 'Claude Code 2.0'],
        ['Reproduction steps', `1. Open\n\n### ${OS}\n\nLinux`],
        ['Expected behavior', 'Works'],
        ['Actual behavior', 'Crashes'],
        ['Logs, screenshots, or additional context', '']
      ]
    ],
    [
      'summary form',
      [
        ['Summary', 'Crash on launch'],
        [OS, 'Windows'],
        ['Orca version', ''],
        ['Details', 'x']
      ]
    ],
    [
      'form on main',
      [
        [OS, 'Windows'],
        ['Orca version', 'v1.4.2'],
        ['Details', 'x']
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
    // A shadowed legacy value is ignored even when it is not an allowed option.
    const shadowed = sections('Mobile app', 'iOS')
      .replace('### Client\n\nMobile', '### Client\n\nSmart fridge')
      .replace('### Host operating system\n\nLinux', '### Host operating system\n\nTempleOS')
    await expectReconciled(shadowed, ['os:mobile', 'mobile'])
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
  const valid = renderBugBody({ [WHERE]: 'Mobile app', [OS]: 'iOS', [REMOTE_OS]: 'Linux' })
  const fenced = `\`\`\`md\n${valid}\n\`\`\``

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'TempleOS'])(
    'unknown or prototype value %s in any dropdown',
    async (value) => {
      await expectUntouched(renderBugBody({ [WHERE]: 'Mobile app', [OS]: value }))
      await expectUntouched(renderBugBody({ [WHERE]: value, [OS]: 'macOS' }))
      await expectUntouched(renderBugBody({ [OS]: 'macOS', [REMOTE_OS]: value }))
      const legacy = renderSections([
        ['Client', value],
        ['Host operating system', 'macOS'],
        ['Orca version', ''],
        ['Details', 'x']
      ])
      await expectUntouched(legacy)
    }
  )

  it.each(['Mobile', 'Mobile phone', 'Mobile (iOS) beta', 'mobile-app', 'Mobile app, Web browser'])(
    'near-miss Where value %s',
    async (where) => {
      await expectUntouched(renderBugBody({ [WHERE]: where, [OS]: 'iOS' }))
    }
  )

  it.each([
    [
      'repeated OS heading',
      valid.replace(`### ${REMOTE_OS}`, `### ${OS}\n\nLinux\n\n### ${REMOTE_OS}`)
    ],
    [
      'repeated version heading',
      valid.replace('### Details', '### Orca version\n\nv1\n\n### Details')
    ],
    [
      'unknown heading',
      valid.replace('### Orca version', '### Device model\n\nPixel\n\n### Orca version')
    ],
    [
      'OS before Where',
      renderSections([
        [OS, 'iOS'],
        [WHERE, 'Mobile app'],
        ['Orca version', ''],
        ['Details', 'x']
      ])
    ],
    [
      'version before OS',
      renderSections([
        ['Orca version', ''],
        [OS, 'iOS'],
        ['Details', 'x']
      ])
    ],
    [
      'multiline dropdown value',
      valid.replace('### Operating system\n\niOS', '### Operating system\n\niOS\nLinux')
    ],
    [
      'multiline version value',
      valid.replace('_No response_\n\n### Details', 'v1\n\nv2\n\n### Details')
    ],
    [
      'missing version heading',
      renderSections([
        [WHERE, 'Mobile app'],
        [OS, 'iOS'],
        ['Details', 'x']
      ])
    ],
    [
      'missing OS heading',
      renderSections([
        [WHERE, 'Mobile app'],
        ['Orca version', ''],
        ['Details', 'x']
      ])
    ],
    [
      'missing free-text heading',
      renderSections([
        [WHERE, 'Mobile app'],
        [OS, 'iOS'],
        ['Orca version', '']
      ])
    ],
    ['only an OS example', `### ${OS}\n\niOS`],
    ['heading with trailing space', valid.replace(`### ${OS}\n`, `### ${OS} \n`)],
    ['tab after heading marker', valid.replace(`### ${OS}`, `###\t${OS}`)],
    ['lowercased heading', valid.replace(`### ${OS}`, '### operating system')],
    ['indented first heading', ` ${valid}`],
    ['level-two headings', valid.replace(/^### /gm, '## ')],
    ['lone CR line endings', valid.replace(/\n/g, '\r')],
    ['leading prose', `Hello team,\n\n${valid}`],
    ['leading blockquote', `> quoted\n\n${valid}`],
    ['leading code fence', fenced],
    ['leading indented code', valid.replace(/^/gm, '    ')],
    ['leading HTML comment', `<!-- note -->\n${valid}`],
    ['empty body', ''],
    ['missing body', null]
  ])('%s', async (_name, body) => {
    await expectUntouched(body)
  })

  it('Other and Feature forms, even with a bug form pasted into their text', async () => {
    const other = readIssueForm('other')
    const feature = readIssueForm('feature_request')
    await expectUntouched(renderFormBody(other, { Details: 'Question about billing.' }))
    await expectUntouched(renderFormBody(other, { Details: valid }))
    await expectUntouched(renderFormBody(other, { Details: fenced }))
    await expectUntouched(
      renderFormBody(feature, { 'Problem or use case': valid, 'Proposed solution': fenced })
    )
  })
})

describe('free text after the metadata prefix', () => {
  it.each([
    [
      'conflicting form example',
      `### ${OS}\n\nLinux\n\n### Where were you using Orca?\n\nDesktop only`
    ],
    ['fenced form example', `\`\`\`\n### ${OS}\n\nLinux\n\`\`\``],
    [
      'unknown, repeated and malformed headings',
      `### Details\n\n### Device\n\n### ${OS}\nA\nB\n###`
    ],
    ['prototype-looking text', `### ${OS}\n\n__proto__\n\nconstructor`]
  ])('ignores a %s in Details', async (_name, details) => {
    const body = renderBugBody({ [WHERE]: 'Mobile app', [OS]: 'Android', Details: details })
    await expectReconciled(body, ['os:mobile', 'mobile'])
  })
})
