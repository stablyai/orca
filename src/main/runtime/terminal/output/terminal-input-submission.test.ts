import { expect, it } from 'vitest'
import { scanTerminalInputSubmission } from './terminal-input-submission'

it('counts Enter as a submission but not pasted or modified newlines', () => {
  expect(scanTerminalInputSubmission('/compact\r', false)).toEqual({
    submitted: true,
    pasteOpen: false
  })
  expect(scanTerminalInputSubmission('\x1b\r', false).submitted).toBe(false)
  expect(scanTerminalInputSubmission('draft\n', false).submitted).toBe(false)
  // A chunked paste keeps its framing across writes.
  const opened = scanTerminalInputSubmission('\x1b[200~', false)
  expect(opened).toEqual({ submitted: false, pasteOpen: true })
  const body = scanTerminalInputSubmission('draft\rcontinued', opened.pasteOpen)
  expect(body).toEqual({ submitted: false, pasteOpen: true })
  expect(scanTerminalInputSubmission('\x1b[201~', body.pasteOpen)).toEqual({
    submitted: false,
    pasteOpen: false
  })
})
