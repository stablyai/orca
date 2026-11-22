import { expect, it } from 'vitest'
import { decodeOmpTranscriptLine } from './transcript-line-decoders-omp'

// Captured from OMP 18.22.0 with the advisor enabled.
const ADVISOR_LINE = String.raw`{"type":"custom_message","customType":"advisor","content":"<advisory severity=\"concern\" guidance=\"weigh, don't blindly obey\">\nCheck the edge case for empty input before finishing.\n</advisory>","display":true,"details":{"notes":[{"note":"Check the edge case for empty input before finishing.","severity":"concern"}]},"attribution":"agent","id":"223bb4a6","parentId":"0e9d0822","timestamp":"2026-11-17T19:23:05.935Z","runtime":{"version":"18.22.0"}}`

it('shows an OMP advisor card as its notes, not the model-facing advisory markup', () => {
  expect(decodeOmpTranscriptLine(ADVISOR_LINE, 'fallback')?.blocks).toEqual([
    {
      type: 'text',
      text: 'Advisor (concern): Check the edge case for empty input before finishing.'
    }
  ])
})
