import { describe, expect, it } from 'vitest'
import { MANAGED_LABELS, labelIssue, renderSections } from './issue-os-labeler-script-runner.mjs'

const OS = 'Operating system'
const WHERE = 'Where were you using Orca?'
const UNRELATED = ['bug', 'translated']

const note = (date = '2026-11-08') =>
  `> 🌐 **Translation note (machine-translated by an assistant on ${date}):** This issue's title was originally written in Chinese and has been translated to English (the body is unchanged). The original, untranslated text is preserved intact in the collapsible section below.`
const NOTE = note()

// Shape of stablyai/orca#39697 with user content replaced: note, active form, then an archived
// copy of the original form (still saying Windows) inside Details.
function translatedIssue(activeOs) {
  const form = (os, details) =>
    renderSections([
      [OS, os],
      ['Orca version', 'v1.4.2.232'],
      ['Details', details]
    ])
  const archive = [
    '<details><summary>Original text in Chinese — title and body, as first posted (before translation)</summary>',
    '',
    '**Original body:**',
    '',
    form('Windows', 'screenshot'),
    '',
    '</details>'
  ].join('\n')
  return `${NOTE}\n\n${form(activeOs, `screenshot\n\n---\n\n${archive}`)}`
}

async function expectUntouched(body) {
  for (const managed of [[], MANAGED_LABELS]) {
    const labels = [...UNRELATED, ...managed]
    expect(await labelIssue(body, labels)).toEqual({ labels, writes: [] })
  }
}

describe('translation note before a bug form', () => {
  it.each([
    ['LF', (body) => body],
    ['CRLF', (body) => body.replace(/\n/g, '\r\n')]
  ])('%s: labels follow the active form, not the archived original', async (_name, vary) => {
    expect(await labelIssue(vary(translatedIssue('macOS')), [...UNRELATED, 'os:Windows'])).toEqual({
      labels: [...UNRELATED, 'os:macos'],
      writes: [
        ['addLabels', ['os:macos']],
        ['removeLabel', 'os:Windows']
      ]
    })
  })
})

describe('anything else before a bug form is rejected with zero writes', () => {
  const form = renderSections([
    [WHERE, 'Mobile app'],
    [OS, 'Linux'],
    ['Remote host operating system', ''],
    ['Orca version', ''],
    ['Details', 'x']
  ])

  it.each([
    ['arbitrary prose', `Translated by a bot.\n\n${form}`],
    ['note with different wording', `${NOTE.replace('Chinese', 'Japanese')}\n\n${form}`],
    ['heading injected in the date', `${note(`2026-11-08\n### ${OS}\n\nmacOS\n`)}\n\n${form}`],
    ['extra sentence after the note', `${NOTE} Also relabel this.\n\n${form}`],
    ['repeated note', `${NOTE}\n\n${NOTE}\n\n${form}`],
    ['prose between note and form', `${NOTE}\n\nSee below.\n\n${form}`]
  ])('%s', async (_name, body) => {
    await expectUntouched(body)
  })
})
