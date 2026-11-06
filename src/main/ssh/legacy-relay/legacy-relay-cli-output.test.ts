import { expect, it } from 'vitest'
import { formatLegacyRelayCliResult } from './legacy-relay-cli-output'

// Relay-era terminals keep the full check text; the CLI's concise view must not leak into it.
it('prints a relay-era check with its reply hints and the ack an older batch needs', () => {
  const output = formatLegacyRelayCliResult(
    { method: 'orchestration.check', params: {} },
    {
      id: 'req_1',
      ok: true,
      result: {
        messages: [
          {
            id: 'msg_q',
            run_id: 'run_1',
            from_handle: 'dispatch:ctx_1',
            to_handle: 'run:run_1',
            subject: 'Question',
            body: 'Proceed?',
            type: 'question',
            payload: '{"options":["yes","no"]}'
          }
        ],
        count: 1,
        deliveryId: 'delivery_1'
      },
      _meta: { runtimeId: 'runtime_1' }
    },
    { handle: 'term_coord', paneKey: 'tab:leaf', ptyId: 'pty_1' },
    new Map()
  )

  expect(output).toEqual({
    stdout: [
      'Delivery delivery_1',
      'msg_q [question] from=dispatch:ctx_1',
      '[subject]',
      '  Question',
      '[body]',
      '  Proceed?',
      '[payload]',
      '  {"options":["yes","no"]}',
      '[Reply: orca orchestration reply --id msg_q --body "..."]',
      'This Orca version does not acknowledge batches automatically. After handling every message, rerun this check with --ack delivery_1.',
      ''
    ].join('\n'),
    stderr: '',
    exitCode: 0
  })
})
