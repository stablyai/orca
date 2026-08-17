import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  LinearProjectLabelsResult,
  LinearProjectShowResult,
  LinearProjectStatusesResult
} from '../shared/linear/project-agent-access'
import * as sharedProjectFormat from '../shared/linear/project-agent-format'
import type { LinearProjectUpdateAddResult } from '../shared/linear/project-agent-writes'
import {
  escapeJsonControlCharacters,
  formatLinearProjectLabels,
  formatLinearProjectShow,
  formatLinearProjectStatuses,
  formatLinearProjectUpdateAdd,
  printLinearProjectLabelsWarnings,
  printLinearProjectResult,
  printLinearProjectStatusesWarnings,
  sanitizeLinearProjectText,
  toSingleLineLinearProjectText
} from './linear-project-format'

// Why: real cursor-moving frames — CSI erase/up, an OSC title write, and 8-bit C1 forms.
const CURSOR_ATTACK = '\u001b[2Kmalicious\u001b[1Aoverwritten\u001b]0;pwned\u0007'
const C1_ATTACK = 'tail\u009bA\u009d0;pwned\u009c\u007fend'

function hasTerminalControlBytes(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0
    if (code === 0x09 || code === 0x0a) {
      return false
    }
    return code < 0x20 || (code >= 0x7f && code <= 0x9f)
  })
}

function boundedString(value: string, overrides: Partial<{ truncated: boolean }> = {}) {
  return {
    value,
    truncated: overrides.truncated ?? false,
    chars: value.length,
    sha256: 'a'.repeat(64)
  }
}

function collection<TItem extends { id: string }>(items: TItem[], total = items.length) {
  return {
    items,
    returned: items.length,
    total,
    truncated: items.length < total,
    sha256: 'b'.repeat(64)
  }
}

function showResult(overrides: Partial<LinearProjectShowResult> = {}): LinearProjectShowResult {
  return {
    project: {
      id: 'project-1',
      name: 'Launch Q3',
      slugId: 'launch-q3',
      url: 'https://linear.app/acme/project/launch-q3-1a2b3c',
      description: boundedString('Ship the launch'),
      content: boundedString('# Overview\nLine two'),
      status: { id: 'status-1', name: 'In Progress', type: 'started', color: '#00ff00' },
      lead: { id: 'user-1', displayName: 'Ada', avatarUrl: null },
      members: collection([{ id: 'user-1', displayName: 'Ada', avatarUrl: null }]),
      teams: collection([{ id: 'team-1', name: 'Engineering', key: 'ENG' }], 4),
      labels: collection([
        { id: 'label-1', name: 'Launch', color: '#ff0000', parent: { id: 'g1', name: 'Phase' } }
      ]),
      priority: 2,
      startDate: '2026-01-01',
      targetDate: '2026-03-01',
      color: '#123456',
      icon: 'Rocket',
      health: 'onTrack',
      healthUpdatedAt: '2026-06-01T00:00:00.000Z'
    },
    meta: {
      workspaceId: 'workspace-1',
      workspaceName: 'Acme',
      resolvedBy: 'slug'
    },
    ...overrides
  } as LinearProjectShowResult
}

function statusesResult(
  overrides: Partial<LinearProjectStatusesResult['meta']> = {}
): LinearProjectStatusesResult {
  return {
    statuses: [
      {
        id: 'status-1',
        name: 'In Progress',
        type: 'started',
        color: '#00ff00',
        workspaceId: 'workspace-1',
        workspaceName: 'Acme'
      }
    ],
    meta: {
      limit: 20,
      returned: 1,
      partial: false,
      workspaceResults: [
        { workspace: { id: 'workspace-1', name: 'Acme' }, returned: 1, hasMore: false }
      ],
      workspaceErrors: [],
      ...overrides
    }
  } as LinearProjectStatusesResult
}

function labelsResult(): LinearProjectLabelsResult {
  return {
    labels: [
      {
        id: 'label-1',
        name: 'Launch',
        color: '#ff0000',
        parent: { id: 'g1', name: 'Phase' },
        workspaceId: 'workspace-1',
        workspaceName: 'Acme'
      }
    ],
    meta: {
      limit: 20,
      returned: 1,
      partial: false,
      workspaceResults: [
        { workspace: { id: 'workspace-1', name: 'Acme' }, returned: 1, hasMore: false }
      ],
      workspaceErrors: []
    }
  } as LinearProjectLabelsResult
}

// Why: same function identity is the proof that local and SSH human output cannot drift.
describe('shared renderer delegation', () => {
  it('re-exports the shared formatters SSH also renders through', () => {
    expect(formatLinearProjectShow).toBe(sharedProjectFormat.formatLinearProjectShow)
    expect(formatLinearProjectStatuses).toBe(sharedProjectFormat.formatLinearProjectStatuses)
    expect(formatLinearProjectLabels).toBe(sharedProjectFormat.formatLinearProjectLabels)
    expect(formatLinearProjectUpdateAdd).toBe(sharedProjectFormat.formatLinearProjectUpdateAdd)
    expect(sanitizeLinearProjectText).toBe(sharedProjectFormat.sanitizeLinearProjectText)
    expect(toSingleLineLinearProjectText).toBe(sharedProjectFormat.toSingleLineLinearProjectText)
  })
})

describe('formatLinearProjectShow', () => {
  it('renders identity, fields, bounded text and collection digests without updates', () => {
    const output = formatLinearProjectShow(showResult())

    expect(output).toContain('Launch Q3 (launch-q3)')
    expect(output).toContain('URL: https://linear.app/acme/project/launch-q3-1a2b3c')
    expect(output).toContain('Workspace: Acme (workspace-1) via slug')
    expect(output).toContain('Status: In Progress (started)')
    expect(output).toContain('Health: on-track updated 2026-06-01T00:00:00.000Z')
    expect(output).toContain('Priority: high')
    expect(output).toContain('Dates: 2026-01-01 -> 2026-03-01')
    expect(output).toContain(`Description: 15 chars sha256 ${'a'.repeat(64)}`)
    expect(output).toContain(`Members: 1 - Ada sha256 ${'b'.repeat(64)}`)
    expect(output).toContain('Labels: 1 - Phase/Launch')
    expect(output).not.toContain('Updates:')
  })

  it('marks a truncated collection with its returned count', () => {
    const output = formatLinearProjectShow(showResult())

    expect(output).toContain('Teams: 4 (showing 1) - ENG Engineering')
  })

  it('marks truncated bounded text and a null content value', () => {
    const result = showResult()
    result.project.description = boundedString('Ship the launch', { truncated: true })
    result.project.content = { value: null, truncated: false, chars: 0, sha256: '' }

    const output = formatLinearProjectShow(result)

    expect(output).toContain('(truncated)')
    expect(output).toContain('Content: none')
  })

  it('renders the update feed and its truncation marker with --updates', () => {
    const result = showResult({
      updates: [
        {
          id: 'update-1',
          body: boundedString('Shipped the beta\nSecond line'),
          health: 'atRisk',
          url: 'https://linear.app/acme/project/launch-q3-1a2b3c#update-1',
          isDiffHidden: false,
          isStale: true,
          createdAt: '2026-06-01T00:00:00.000Z',
          updatedAt: '2026-06-01T00:00:00.000Z',
          editedAt: null,
          user: { id: 'user-1', displayName: 'Ada', avatarUrl: null }
        }
      ],
      meta: {
        workspaceId: 'workspace-1',
        workspaceName: 'Acme',
        resolvedBy: 'slug',
        updates: { returned: 1, cap: 5, capReached: false, hasMore: true }
      }
    })

    const output = formatLinearProjectShow(result)

    expect(output).toContain('Updates: 1 (more available)')
    expect(output).toContain('2026-06-01T00:00:00.000Z Ada at-risk (stale)')
    expect(output).toContain('Shipped the beta Second line')
  })
})

describe('metadata list formatting', () => {
  it('renders status and label rows and their empty states', () => {
    expect(formatLinearProjectStatuses(statusesResult())).toContain('In Progress')
    expect(formatLinearProjectStatuses({ ...statusesResult(), statuses: [] })).toBe(
      'No Linear project statuses found.'
    )
    expect(formatLinearProjectLabels(labelsResult())).toContain('Phase/Launch')
    expect(formatLinearProjectLabels({ ...labelsResult(), labels: [] })).toBe(
      'No Linear project labels found.'
    )
  })
})

function updateAddResult(deduplicated = false): LinearProjectUpdateAddResult {
  return {
    projectUpdate: {
      id: 'update-1',
      url: 'https://linear.app/acme/project/launch-q3-1a2b3c#update-1',
      health: 'offTrack',
      createdAt: '2026-06-01T00:00:00.000Z'
    },
    project: {
      id: 'project-1',
      name: 'Launch Q3',
      slugId: 'launch-q3',
      url: 'https://linear.app/acme/project/launch-q3-1a2b3c'
    },
    meta: {
      workspaceId: 'workspace-1',
      bodyChars: 42,
      writeId: '123e4567-e89b-12d3-a456-426614174000',
      deduplicated
    }
  }
}

describe('formatLinearProjectUpdateAdd', () => {
  it('summarizes a new post with its health, url, size and write id', () => {
    const output = formatLinearProjectUpdateAdd(updateAddResult())

    expect(output).toContain('Posted Linear project update on Launch Q3 (launch-q3)')
    expect(output).toContain('Update: update-1 off-track 2026-06-01T00:00:00.000Z')
    expect(output).toContain('URL: https://linear.app/acme/project/launch-q3-1a2b3c#update-1')
    expect(output).toContain('Body: 42 chars')
    expect(output).toContain('Write id: 123e4567-e89b-12d3-a456-426614174000')
  })

  it('marks a deduplicated post so a retry is never read as a second update', () => {
    const output = formatLinearProjectUpdateAdd(updateAddResult(true))

    expect(output).toContain('Deduplicated Linear project update on Launch Q3 (launch-q3)')
    expect(output).toContain('nothing new was created')
    expect(output).not.toContain('Posted Linear project update')
  })
})

describe('fan-out warnings', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('warns per truncated workspace, per workspace error, and on partial results', () => {
    printLinearProjectStatusesWarnings(
      statusesResult({
        partial: true,
        workspaceResults: [
          { workspace: { id: 'workspace-1', name: 'Acme' }, returned: 1, hasMore: true }
        ],
        workspaceErrors: [
          {
            workspace: { id: 'workspace-2', name: 'Globex' },
            code: 'linear_rate_limited',
            message: 'Rate limited'
          }
        ]
      })
    )

    const warnings = vi.mocked(console.error).mock.calls.map((call) => String(call[0]))
    expect(warnings[0]).toContain('Acme has more Linear project statuses than the 20 shown')
    expect(warnings[1]).toBe(
      'warning: Globex unavailable for Linear project statuses: Rate limited'
    )
    expect(warnings[2]).toBe(
      'warning: Linear project statuses results are partial across workspaces'
    )
  })

  it('names project labels in its own warnings', () => {
    printLinearProjectLabelsWarnings(labelsResult())

    expect(console.error).not.toHaveBeenCalled()
  })
})

describe('terminal-control safety', () => {
  it('removes ANSI, OSC and C0/C1 controls from sanitized text', () => {
    expect(sanitizeLinearProjectText(CURSOR_ATTACK)).toBe('maliciousoverwritten')
    expect(sanitizeLinearProjectText(C1_ATTACK)).toBe('tailend')
  })

  it('collapses line breaks in single-line fields', () => {
    expect(toSingleLineLinearProjectText('first\r\nsecond\rthird\nfourth')).toBe(
      'first second third fourth'
    )
  })

  it('leaves no cursor-moving byte in human show output', () => {
    const result = showResult()
    result.project.name = CURSOR_ATTACK
    result.project.description = boundedString(`intro\n${C1_ATTACK}`)
    result.meta.workspaceName = C1_ATTACK

    const output = formatLinearProjectShow(result)

    expect(hasTerminalControlBytes(output)).toBe(false)
    expect(output).toContain('maliciousoverwritten')
  })

  it('leaves no cursor-moving byte in a human project-update post summary', () => {
    const result = updateAddResult()
    result.project.name = CURSOR_ATTACK

    const output = formatLinearProjectUpdateAdd(result)

    expect(hasTerminalControlBytes(output)).toBe(false)
    expect(output).toContain('maliciousoverwritten')
  })

  it('escapes control bytes in serialized JSON while JSON.parse round-trips exactly', () => {
    const original = { name: CURSOR_ATTACK, body: C1_ATTACK }
    const serialized = escapeJsonControlCharacters(JSON.stringify(original, null, 2))

    expect(hasTerminalControlBytes(serialized)).toBe(false)
    expect(JSON.parse(serialized)).toEqual(original)
  })

  it('emits control-free JSON through the shared project result printer', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const result = showResult()
    result.project.name = CURSOR_ATTACK
    result.project.content = boundedString(C1_ATTACK)

    printLinearProjectResult(
      { id: 'req_1', ok: true, result, _meta: { runtimeId: 'runtime-1' } },
      true,
      formatLinearProjectShow
    )

    const printed = String(logSpy.mock.calls[0][0])
    expect(hasTerminalControlBytes(printed)).toBe(false)
    const parsed = JSON.parse(printed) as { result: LinearProjectShowResult }
    expect(parsed.result.project.name).toBe(CURSOR_ATTACK)
    expect(parsed.result.project.content.value).toBe(C1_ATTACK)
    logSpy.mockRestore()
  })
})
