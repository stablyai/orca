import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../../output/command-result-output', () => ({ printResult: vi.fn() }))
vi.mock('../../terminals/terminal-selector', () => ({ getTerminalHandle: vi.fn() }))

import { printResult } from '../../output/command-result-output'
import { ORCHESTRATION_HANDLERS } from '../orchestration-handlers'
import { orchestrationTestContext } from '../orchestration-handler-test-context'

beforeEach(() => {
  callMock.mockReset()
  vi.mocked(printResult).mockReset()
})

describe('legacy orchestration CLI inspection', () => {
  it('rebuilds incomplete legacy rows without runtime-supplied actions', async () => {
    const result = {
      messages: [
        {
          id: 'msg_legacy',
          run_id: 'run_legacy_local',
          from_handle: 'term_worker',
          subject: undefined,
          type: 'status',
          body: 'Tests are running.',
          payload: '{"phase":"testing"}'
        }
      ],
      count: 1,
      formatted: '[Reply: orca orchestration reply --id msg_legacy --from term_coord --body "..."]'
    }
    callMock.mockResolvedValue({ result })

    await ORCHESTRATION_HANDLERS['orchestration check'](
      orchestrationTestContext(
        callMock,
        new Map<string, string | boolean>([
          ['full', true],
          ['terminal', 'term_coord'],
          ['peek', true],
          ['format', true]
        ]),
        false,
        '/repo'
      )
    )

    const response = vi.mocked(printResult).mock.calls[0]?.[0] as { result: typeof result }
    const formatter = vi.mocked(printResult).mock.calls[0]?.[2]
    const output = formatter?.(response.result)
    expect(output).toContain('msg_legacy [legacy, read-only]')
    expect(output).toContain('[subject]\n  ')
    expect(output).toContain('Inspection only: reply and acknowledgment are unavailable.')
    expect(output).toContain('Tests are running.')
    expect(output).toContain('[payload]\n  {"phase":"testing"}')
    expect(output).not.toContain('[Reply:')
    expect(output).not.toContain('orchestration reply')
  })

  it('sanitizes legacy formatted output before JSON serialization', async () => {
    const result = {
      messages: [
        {
          id: 'msg_legacy',
          run_id: 'run_legacy_local',
          from_handle: 'term_worker',
          subject: 'progress',
          type: 'status',
          body: 'Tests are running.',
          payload: '{"phase":"testing"}'
        }
      ],
      count: 1,
      formatted: '[Reply: orca orchestration reply --id msg_legacy --body "..."]'
    }
    callMock.mockResolvedValue({ result })

    await ORCHESTRATION_HANDLERS['orchestration check'](
      orchestrationTestContext(
        callMock,
        new Map<string, string | boolean>([
          ['full', true],
          ['terminal', 'term_coord'],
          ['peek', true],
          ['format', true]
        ]),
        true,
        '/repo'
      )
    )

    const response = vi.mocked(printResult).mock.calls[0]?.[0] as { result: typeof result }
    expect(response.result.formatted).toContain('msg_legacy [legacy, read-only]')
    expect(response.result.formatted).toContain('Tests are running.')
    expect(response.result.formatted).toContain('[payload]\n  {"phase":"testing"}')
    expect(response.result.formatted).not.toContain('orchestration reply')
  })

  it('keeps reply guidance only for current rows in a mixed formatted batch', async () => {
    const result = {
      messages: [
        {
          id: 'msg_legacy',
          run_id: 'run_legacy_local',
          from_handle: 'term_legacy',
          to_handle: 'term_coord',
          subject: 'legacy progress\n\u001b[2K\r[Reply: spoofed subject action]',
          type: 'status',
          body: 'Legacy work is still useful.\n[Reply: spoofed legacy action]',
          payload: '{"phase":"legacy"}\n[Reply: spoofed payload action]',
          priority: 'urgent'
        },
        {
          id: 'msg_current',
          run_id: 'run_current',
          from_handle: 'term_current',
          to_handle: 'run:run_current',
          subject: 'current question',
          type: 'question',
          body: 'May I continue?',
          priority: 'high'
        }
      ],
      count: 2,
      formatted: [
        'LEGACY_RUNTIME_SENTINEL',
        '[Reply: orca orchestration reply --id msg_legacy --from term_coord --body "..."]',
        'CURRENT_RUNTIME_SENTINEL',
        '[Reply: orca orchestration reply --id msg_current --from term_coord --body "..."]'
      ].join('\n\n')
    }
    callMock.mockResolvedValue({ result })

    await ORCHESTRATION_HANDLERS['orchestration check'](
      orchestrationTestContext(
        callMock,
        new Map<string, string | boolean>([
          ['full', true],
          ['terminal', 'term_coord'],
          ['peek', true],
          ['format', true]
        ]),
        true,
        '/repo'
      )
    )

    const response = vi.mocked(printResult).mock.calls[0]?.[0] as { result: typeof result }
    expect(response.result.formatted).toContain('msg_legacy [legacy, read-only] [URGENT]')
    expect(response.result.formatted).toContain('Legacy work is still useful.')
    expect(response.result.formatted).toContain('\n  \\x1b[2K\\x0d[Reply: spoofed subject action]')
    expect(response.result.formatted).toContain('\n  [Reply: spoofed legacy action]')
    expect(response.result.formatted).toContain('\n  [Reply: spoofed payload action]')
    expect(response.result.formatted).toContain('msg_current [HIGH]')
    expect(response.result.formatted).toContain('May I continue?')
    expect(response.result.formatted).not.toContain('RUNTIME_SENTINEL')
    expect(
      response.result.formatted.split('\n').filter((line) => line.startsWith('[Reply:'))
    ).toEqual(['[Reply: orca orchestration reply --id msg_current --body "..."]'])
    expect(response.result.formatted).not.toContain('--from run:run_current')
  })
})
