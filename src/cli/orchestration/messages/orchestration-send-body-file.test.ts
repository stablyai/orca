import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const callMock = vi.fn()
vi.mock('../../output/command-result-output', () => ({ printResult: vi.fn() }))
vi.mock('../../terminals/terminal-selector', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from '../orchestration-handlers'
import { orchestrationTestContext } from '../orchestration-handler-test-context'

const BODY = '## Open\n- PR #12 "waiting" on `pnpm test`, cost $HOME\n\n## Done\nnothing\n'

let dir: string | undefined

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true })
    dir = undefined
  }
})

it('sends a --body-file text as the message body unchanged', async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-send-body-file-'))
  writeFileSync(join(dir, 'handoff.md'), BODY)
  callMock.mockReset().mockResolvedValue({ result: { message: { id: 'msg_1' } } })

  await ORCHESTRATION_HANDLERS['orchestration send'](
    orchestrationTestContext(
      callMock,
      new Map<string, string | boolean>([
        ['full', true],
        ['from', 'term_sender'],
        ['to', 'term_recipient'],
        ['subject', 'hand-off'],
        ['body-file', 'handoff.md']
      ]),
      false,
      dir
    )
  )

  const send = callMock.mock.calls.find(([method]) => method === 'orchestration.send')
  expect(send?.[1]).toMatchObject({ body: BODY })
})
