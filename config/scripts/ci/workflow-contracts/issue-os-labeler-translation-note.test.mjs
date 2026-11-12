import { describe, expect, it } from 'vitest'
import {
  MANAGED_LABELS,
  labelIssue,
  readIssueForm,
  renderBugBody,
  renderFormBody,
  renderSections
} from './issue-os-labeler-script-runner.mjs'

const OS = 'Operating system'
const WHERE = 'Where were you using Orca?'
const UNRELATED = ['bug', 'translated']

const note = (date = '2026-11-08') =>
  `> 🌐 **Translation note (machine-translated by an assistant on ${date}):** This issue's title was originally written in Chinese and has been translated to English (the body is unchanged). The original, untranslated text is preserved intact in the collapsible section below.`
const NOTE = note()

// Shape of stablyai/orca#38886 and #39697 with user content replaced: note, active form, then an
// archived copy of the original form (still saying Windows) inside Details.
function translatedIssue(activeOs, version) {
  const form = (os, details) =>
    renderSections([
      [OS, os],
      ['Orca version', version],
      ['Details', details]
    ])
  const image = '<img width="1463" height="927" alt="Image" src="https://example.invalid/a.png" />'
  const archive = [
    '<details><summary>Original text in Chinese — title and body, as first posted (before translation)</summary>',
    '',
    '',
    '**Original title:** [Bug]: 示例标题',
    '',
    '**Original body:**',
    '',
    form('Windows', image),
    '',
    '</details>'
  ].join('\n')
  return `${NOTE}\n\n${form(activeOs, `${image}\n\n---\n\n${archive}`)}`
}

async function expectManaged(body, managed, startingManaged = ['os:Windows']) {
  const result = await labelIssue(body, [...UNRELATED, ...startingManaged])
  expect(result.labels.filter((label) => !MANAGED_LABELS.includes(label))).toEqual(UNRELATED)
  expect(result.labels.filter((label) => MANAGED_LABELS.includes(label))).toEqual(managed)
  return result
}

async function expectUntouched(body) {
  for (const managed of [[], MANAGED_LABELS]) {
    const labels = [...UNRELATED, ...managed]
    expect(await labelIssue(body, labels)).toEqual({ labels, writes: [] })
  }
}

describe('translation note before a bug form', () => {
  it('matches the 275-character note observed on the annotated issues', () => {
    expect([...NOTE]).toHaveLength(275)
  })

  describe.each([
    ['#38886 shape (version unselected)', ''],
    ['#39697 shape (version set)', 'v1.4.2.232']
  ])('%s', (_name, version) => {
    it.each([
      ['LF', (body) => body],
      ['CRLF', (body) => body.replace(/\n/g, '\r\n')],
      ['leading blank lines', (body) => `\n \n\t\n${body}`],
      ['extra separating blank lines', (body) => body.replace(`${NOTE}\n\n`, `${NOTE}\n\n \t\n\n`)],
      ['trailing blank lines', (body) => `${body}\n\n\n`]
    ])('%s: labels follow the active form, not the archived original', async (_variant, vary) => {
      const unchanged = await expectManaged(vary(translatedIssue('Windows', version)), [
        'os:Windows'
      ])
      expect(unchanged.writes).toEqual([])

      const toMac = await expectManaged(vary(translatedIssue('macOS', version)), ['os:macos'])
      expect(toMac.writes).toEqual([
        ['addLabels', ['os:macos']],
        ['removeLabel', 'os:Windows']
      ])

      await expectManaged(vary(translatedIssue('Linux', version)), ['os:linux'])
      await expectManaged(vary(translatedIssue('Other', version)), [])
    })
  })

  it.each([
    [
      'current form',
      renderBugBody({ [WHERE]: 'Mobile app', [OS]: 'Android' }),
      ['os:mobile', 'mobile']
    ],
    [
      'retired Where options',
      renderSections([
        [WHERE, 'Mobile (iOS)'],
        [OS, 'iOS'],
        ['Remote host operating system', ''],
        ['Orca version', ''],
        ['Details', 'x']
      ]),
      ['os:mobile', 'mobile']
    ],
    [
      'Client and Host operating system headings',
      renderSections([
        ['Client', 'Mobile'],
        ['Host operating system', 'Linux'],
        ['Orca version', ''],
        ['Details', 'x']
      ]),
      ['os:linux', 'mobile']
    ],
    [
      'summary form',
      renderSections([
        ['Summary', 's'],
        [OS, 'macOS'],
        ['Orca version', ''],
        ['Details', 'x']
      ]),
      ['os:macos']
    ],
    [
      'first form',
      renderSections([
        ['Summary', 's'],
        [OS, 'Linux'],
        ['Orca version', ''],
        ['Coding harness and version', ''],
        ['Reproduction steps', 'x']
      ]),
      ['os:linux']
    ]
  ])('accepts the same note before the %s', async (_name, form, managed) => {
    await expectManaged(`${NOTE}\n\n${form}`, managed)
    await expectManaged(`${NOTE}\r\n\r\n${form.replace(/\n/g, '\r\n')}`, managed)
  })

  it('accepts any date of the right shape, since the date carries no authority', async () => {
    await expectManaged(`${note('9999-99-99')}\n\n${renderBugBody({ [OS]: 'Linux' })}`, [
      'os:linux'
    ])
  })

  it('ignores further notes and conflicting forms once free text has started', async () => {
    const details = `${NOTE}\n\n${renderBugBody({ [WHERE]: 'Mobile app', [OS]: 'iOS' })}`
    const body = `${NOTE}\n\n${renderBugBody({ [WHERE]: 'Desktop only', [OS]: 'macOS', Details: details })}`
    await expectManaged(body, ['os:macos'])
  })
})

describe('anything else before a bug form is rejected with zero writes', () => {
  const form = renderBugBody({ [WHERE]: 'Mobile app', [OS]: 'iOS' })
  const fence = '```'

  it.each([
    ['arbitrary prose', `Translated by a bot.\n\n${form}`],
    ['arbitrary blockquote', `> 🌐 **Translation note:** translated.\n\n${form}`],
    ['code fence', `${fence}\n${NOTE}\n${fence}\n\n${form}`],
    ['note with different wording', `${NOTE.replace('Chinese', 'Japanese')}\n\n${form}`],
    ['note without bold markers', `${NOTE.replaceAll('**', '')}\n\n${form}`],
    ['note with a different emoji', `${NOTE.replace('🌐', '🌍')}\n\n${form}`],
    ['note with a curly apostrophe', `${NOTE.replace("issue's", 'issue’s')}\n\n${form}`],
    ['note without the final period', `${NOTE.slice(0, -1)}\n\n${form}`],
    ['note without the blockquote marker', `${NOTE.slice(2)}\n\n${form}`],
    ['date missing a digit', `${note('2026-11-8')}\n\n${form}`],
    ['date with an extra digit', `${note('2026-11-088')}\n\n${form}`],
    ['date with letters', `${note('2026-Nov-08')}\n\n${form}`],
    ['date with full-width digits', `${note('２０２６-11-08')}\n\n${form}`],
    ['empty date', `${note('')}\n\n${form}`],
    ['newline injected in the date', `${note('2026-11-08\n')}\n\n${form}`],
    ['heading injected in the date', `${note(`2026-11-08\n### ${OS}\n`)}\n\n${form}`],
    ['same-length date holding a line break', `${note('2026-11\n08')}\n\n${form}`],
    ['extra sentence after the note', `${NOTE} Also relabel this.\n\n${form}`],
    ['trailing space after the note', `${NOTE} \n\n${form}`],
    ['indented note', ` ${NOTE}\n\n${form}`],
    ['note continued on a second line', `${NOTE}\n> more quote\n\n${form}`],
    ['repeated note', `${NOTE}\n\n${NOTE}\n\n${form}`],
    ['no blank line after the note', `${NOTE}\n${form}`],
    ['lone CR after the note', `${NOTE}\r\r${form}`],
    ['prose between note and form', `${NOTE}\n\nSee below.\n\n${form}`],
    ['code fence between note and form', `${NOTE}\n\n${fence}\n${form}\n${fence}`],
    ['blockquote between note and form', `${NOTE}\n\n> quoted\n\n${form}`],
    ['prose before a valid note', `Hi.\n\n${NOTE}\n\n${form}`],
    ['code fence before a valid note', `${fence}\nlog\n${fence}\n\n${NOTE}\n\n${form}`],
    ['note alone', NOTE],
    ['note and blank lines alone', `${NOTE}\n\n\n`],
    [
      'note then a form missing its version',
      `${NOTE}\n\n${renderSections([
        [OS, 'iOS'],
        ['Details', 'x']
      ])}`
    ],
    [
      'note then a form missing its free-text heading',
      `${NOTE}\n\n${renderSections([
        [OS, 'iOS'],
        ['Orca version', '']
      ])}`
    ],
    [
      'note then a duplicated heading',
      `${NOTE}\n\n${form.replace('### Orca version', `### ${OS}\n\nLinux\n\n### Orca version`)}`
    ],
    [
      'note then an unknown heading',
      `${NOTE}\n\n${form.replace('### Orca version', '### Device\n\nx\n\n### Orca version')}`
    ],
    [
      'note then out-of-order headings',
      `${NOTE}\n\n${renderSections([
        [OS, 'iOS'],
        [WHERE, 'Mobile app'],
        ['Orca version', ''],
        ['Details', 'x']
      ])}`
    ],
    [
      'note then an unknown OS value',
      `${NOTE}\n\n${form.replace('\n\niOS\n', '\n\nconstructor\n')}`
    ]
  ])('%s', async (_name, body) => {
    await expectUntouched(body)
  })

  it('note followed by an Other or Feature form with a bug form embedded in its text', async () => {
    const other = renderFormBody(readIssueForm('other'), { Details: form })
    const feature = renderFormBody(readIssueForm('feature_request'), {
      'Problem or use case': form,
      'Proposed solution': `${fence}\n${form}\n${fence}`
    })
    await expectUntouched(`${NOTE}\n\n${other}`)
    await expectUntouched(`${NOTE}\n\n${feature}`)
  })
})
