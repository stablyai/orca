import { describe, expect, it } from 'vitest'
import {
  createMessageGraphSessionResumeState,
  parseMessageGraphSessionContent
} from './session-scanner-graph-parsers'

const file = { path: '/tmp/omp-title.jsonl', mtimeMs: 1, modifiedAt: '2026-09-14T00:00:00.000Z' }

const prompt = { type: 'message', message: { role: 'user', content: 'First prompt' } }

const header = { type: 'session', id: 'session-id', cwd: '/folder workspace' }

const line = (record: unknown) => JSON.stringify(record)

async function parse(records: unknown[], agent: 'omp' | 'pi' = 'omp') {
  return parseMessageGraphSessionContent(
    agent,
    file,
    [header, ...records].map(line).join('\n'),
    'darwin'
  )
}

describe('OMP stored history names', () => {
  it.each([
    { type: 'session', title: 'Harness name', titleSource: 'user' },
    {
      type: 'title',
      v: 1,
      title: 'Harness name',
      source: 'user',
      updatedAt: '2026-09-14T01:00:00Z',
      pad: ''
    },
    { type: 'title_change', title: 'Harness name', source: 'user' },
    { type: 'session_info', name: 'Harness name' }
  ])('uses persisted %j ahead of the first prompt', async (record) => {
    expect((await parse([prompt, record]))?.title).toBe('Harness name')
  })

  it('preserves a user name through stale header and later automatic records', async () => {
    expect(
      (
        await parse([
          {
            type: 'title',
            v: 1,
            title: 'User name',
            source: 'user',
            updatedAt: '2026-09-14T02:00:00Z',
            pad: ''
          },
          { ...header, title: 'Old header' },
          prompt,
          {
            type: 'title_change',
            title: 'Auto name',
            source: 'auto',
            timestamp: '2026-09-14T03:00:00Z'
          }
        ])
      )?.title
    ).toBe('User name')
  })

  it('keeps the current slot ahead of older rename entries, allowing a newer rename', async () => {
    const records = [
      {
        type: 'title',
        v: 1,
        title: 'Current slot',
        source: 'user',
        updatedAt: '2026-09-14T02:00:00Z',
        pad: ''
      },
      prompt,
      {
        type: 'title_change',
        title: 'Old rename',
        source: 'user',
        timestamp: '2026-09-14T01:00:00Z'
      }
    ]

    expect((await parse(records))?.title).toBe('Current slot')
    expect(
      (
        await parse([
          ...records,
          {
            type: 'title_change',
            title: 'New rename',
            source: 'user',
            timestamp: '2026-09-14T03:00:00Z'
          }
        ])
      )?.title
    ).toBe('New rename')
  })

  it('preserves fallback behavior for missing, empty or unsupported title records', async () => {
    expect(
      (
        await parse([
          prompt,
          { type: 'title_change', title: ' ', source: 'user' },
          { type: 'title_change', title: 'Unknown', source: 'model' },
          { type: 'session_info', title: 'Wrong field' }
        ])
      )?.title
    ).toBe('First prompt')
    expect(
      (await parse([prompt, { type: 'title_change', title: 'OMP only', source: 'user' }], 'pi'))
        ?.title
    ).toBe('First prompt')
  })

  it('clones title authority for append parsing without mutating previous snapshots', async () => {
    const state = createMessageGraphSessionResumeState('omp', file)

    for (const record of [
      header,
      prompt,
      { type: 'title_change', title: 'User name', source: 'user' }
    ]) {
      state.consumeLine(line(record))
    }

    const previous = await state.finalize('darwin')
    const next = state.clone()
    next.consumeLine(line({ type: 'title_change', title: 'Auto name', source: 'auto' }))
    expect((await next.finalize('darwin'))?.title).toBe('User name')
    next.consumeLine(line({ type: 'title_change', title: 'New name', source: 'user' }))
    expect((await next.finalize('darwin'))?.title).toBe('New name')
    expect(previous?.title).toBe('User name')
    expect(state.identity?.()?.title).toBe('User name')
  })
})
