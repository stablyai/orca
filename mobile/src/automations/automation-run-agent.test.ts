import { describe, expect, it } from 'vitest'
import { canOpenAutomationRunAgent } from './automation-run-agent'
import { automationClient, savedRun } from './automation-test-fixtures'

const leaf = '11111111-1111-4111-8111-111111111111'
const run = {
  ...savedRun(),
  workspaceId: 'folder:saved',
  terminalPaneKey: `original:${leaf}`,
  terminalPtyId: 'recorded-pty'
}
const original = {
  worktreeId: run.workspaceId,
  tabId: 'original',
  leafId: leaf,
  ptyId: 'recorded-pty',
  connected: true
}
const complete = {
  totalCount: 0,
  truncated: false,
  hostScope: { hostIds: ['local'], omittedHostIds: [] }
}

describe('original automation pane evidence', () => {
  it('opens an older exact live pane through one count-driven expansion without resolving or recovering it', async () => {
    const others = Array.from({ length: 205 }, (_, i) => ({
      ...original,
      tabId: `other-${i}`,
      ptyId: `other-${i}`
    }))
    const port = automationClient((_method, params) => {
      const requested =
        params && typeof params === 'object' && 'limit' in params ? params.limit : undefined
      return requested === undefined
        ? { ...complete, terminals: others.slice(0, 200), totalCount: 206, truncated: true }
        : { ...complete, terminals: [...others, original], totalCount: 206 }
    })
    expect(await canOpenAutomationRunAgent(port.client, run)).toBe('available')
    expect(port.send.mock.calls.map(([method]) => method)).toEqual([
      'terminal.list',
      'terminal.list'
    ])
    expect(port.send.mock.calls[1]?.[1]).toEqual({
      worktree: 'id:folder:saved',
      includeVisualLayouts: false,
      limit: 206
    })
  })

  it.each([
    [{ terminals: [original] }, 'available'],
    [{ ...complete, terminals: [{ ...original, connected: false }], totalCount: 1 }, 'unavailable'],
    [
      { ...complete, terminals: [{ ...original, verdict: 'unverifiable' }], totalCount: 1 },
      'unverifiable'
    ],
    [
      { ...complete, terminals: [{ ...original, verdict: 'exited' }], totalCount: 1 },
      'unavailable'
    ],
    [
      { ...complete, terminals: [{ ...original, worktreeId: 'folder:other' }], totalCount: 1 },
      'unavailable'
    ],
    [
      { ...complete, terminals: [{ ...original, ptyId: 'replacement' }], totalCount: 1 },
      'unavailable'
    ],
    [{ terminals: [] }, 'unverifiable'],
    [
      {
        ...complete,
        terminals: [],
        hostScope: { hostIds: ['local', 'newkind:x'], omittedHostIds: ['runtime:peer'] }
      },
      'unavailable'
    ],
    [
      { ...complete, terminals: [], hostScope: { hostIds: ['newkind:x'], omittedHostIds: [] } },
      'unverifiable'
    ],
    [
      {
        ...complete,
        terminals: [],
        hostScope: { hostIds: ['local'], omittedHostIds: ['newkind:x'] }
      },
      'unverifiable'
    ],
    [
      {
        ...complete,
        terminals: [],
        hostScope: { hostIds: ['local'], omittedHostIds: ['ssh:missing'] }
      },
      'unverifiable'
    ],
    [{ ...complete, terminals: [{}], totalCount: 1 }, 'unverifiable'],
    [
      { ...complete, terminals: [], truncated: true, totalCount: Number.MAX_SAFE_INTEGER + 1 },
      'unverifiable'
    ]
  ] as const)(
    'keeps positive identity separate from coverage and liveness (%j)',
    async (reply, expected) => {
      const port = automationClient(() => reply)
      expect(await canOpenAutomationRunAgent(port.client, run)).toBe(expected)
      expect(port.send).toHaveBeenCalledTimes(1)
    }
  )

  it('does not turn a denied read or concurrent inventory growth into evidence of absence', async () => {
    const denied = automationClient(() => {
      throw new Error('forbidden')
    })
    expect(await canOpenAutomationRunAgent(denied.client, run)).toBe('unverifiable')
    let count = 1
    const growing = automationClient(() => ({
      ...complete,
      terminals: [],
      truncated: true,
      totalCount: ++count
    }))
    expect(await canOpenAutomationRunAgent(growing.client, run)).toBe('unverifiable')
    expect(growing.send).toHaveBeenCalledTimes(2)
  })
})
