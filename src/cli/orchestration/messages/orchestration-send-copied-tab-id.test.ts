import { expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../../output/command-result-output', () => ({ printResult: vi.fn() }))
vi.mock('../../terminals/terminal-selector', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from '../orchestration-handlers'
import { orchestrationTestContext } from '../orchestration-handler-test-context'
import { ORCHESTRATION_PEER_MAIL_RUNTIME_CAPABILITY } from '../../../shared/orchestration/orchestration-runtime-capabilities'

const TAB = '0a7cc9d3-af43-4b69-bc20-c11d3f4c9d99'

function respond(): void {
  callMock.mockReset().mockImplementation(async (method: string) =>
    method === 'status.get'
      ? { result: { capabilities: [ORCHESTRATION_PEER_MAIL_RUNTIME_CAPABILITY] } }
      : method === 'session.tabs.listAll'
        ? {
            result: {
              snapshots: [
                {
                  worktree: 'repo::/w',
                  tabs: [
                    { type: 'terminal', id: `${TAB}::l`, parentTabId: TAB, terminal: 'term_local' }
                  ]
                }
              ]
            }
          }
        : { result: { message: { id: 'msg_1' } } }
  )
}

async function send(to: string, on?: string): Promise<unknown> {
  const remote: [string, string][] = on ? [['on', on]] : []
  await ORCHESTRATION_HANDLERS['orchestration send'](
    orchestrationTestContext(
      callMock,
      new Map<string, string | boolean>([
        ['from', 'term_sender'],
        ['to', to],
        ['subject', 'hi'],
        ['body', 'hello'],
        ...remote
      ]),
      false
    )
  )
  return callMock.mock.calls.find(([method]) => method === 'orchestration.send')?.[1]
}

it('sends to the terminal a copied tab id names on this Orca', async () => {
  respond()
  expect(await send(TAB)).toMatchObject({ to: 'term_local' })
})

it('names --to in the recovery steps for a split tab', async () => {
  callMock.mockReset().mockImplementation(async (method: string) =>
    method === 'session.tabs.listAll'
      ? {
          result: {
            snapshots: [
              {
                worktree: 'repo::/w',
                tabs: [
                  { type: 'terminal', id: `${TAB}::a`, parentTabId: TAB, terminal: 'term_a' },
                  { type: 'terminal', id: `${TAB}::b`, parentTabId: TAB, terminal: 'term_b' }
                ]
              }
            ]
          }
        }
      : { result: { message: { id: 'msg_1' } } }
  )
  await expect(send(TAB)).rejects.toMatchObject({
    code: 'invalid_argument',
    data: { nextSteps: ['--to term_a', '--to term_b'] }
  })
  expect(callMock.mock.calls.some(([method]) => method === 'orchestration.send')).toBe(false)
})

it('does not map a copied tab id against this Orca when --on names another server', async () => {
  respond()
  expect(await send(TAB, 'devB')).toMatchObject({ to: TAB })
  expect(callMock.mock.calls.some(([method]) => method === 'session.tabs.listAll')).toBe(false)
})
