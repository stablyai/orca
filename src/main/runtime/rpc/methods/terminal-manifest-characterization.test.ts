import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { TERMINAL_METHODS } from './terminal'
import {
  TerminalMultiplexLegacyAckFrame,
  TerminalMultiplexSourceRangeAckFrame,
  TerminalMultiplexSubscribeFrame
} from './terminal/stream-schemas'

const METHOD_CASES: readonly (readonly [string, unknown, boolean])[] = [
  ['terminal.list', {}, false],
  ['terminal.resolveActive', {}, false],
  ['terminal.resolvePane', { paneKey: 'pane' }, false],
  ['terminal.recoverPane', { paneKey: 'pane', worktreeId: 'worktree' }, false],
  ['terminal.show', { terminal: 'term' }, false],
  ['terminal.read', { terminal: 'term' }, false],
  ['terminal.inspectProcess', { terminal: 'term' }, false],
  ['terminal.isRunningAgent', { terminal: 'term' }, false],
  ['terminal.agentStatus', { terminal: 'term' }, false],
  ['terminal.rename', { terminal: 'term', title: null }, false],
  ['terminal.clearBuffer', { terminal: 'term' }, false],
  ['terminal.send', { terminal: 'term', text: 'x' }, false],
  ['terminal.wait', { terminal: 'term', for: 'exit' }, false],
  ['terminal.create', {}, false],
  ['terminal.split', { terminal: 'term' }, false],
  ['terminal.stop', { worktree: 'worktree' }, false],
  ['terminal.sleep', { worktree: 'worktree' }, false],
  ['terminal.stopExact', { worktree: 'worktree', expectedPtyIds: ['pty'] }, false],
  ['terminal.resizeForClient', { terminal: 'term', mode: 'restore', clientId: 'client' }, false],
  ['terminal.focus', { terminal: 'term' }, false],
  ['terminal.close', { terminal: 'term' }, false],
  ['terminal.closeTab', { terminal: 'term' }, false],
  ['agentTeams.tmuxCompat', { teamId: 'team', token: 'token', envPane: 'pane', argv: [] }, false],
  ['agentTeams.prepareLaunch', { paneKey: 'pane' }, false],
  ['terminal.setDisplayMode', { terminal: 'term', mode: 'auto' }, false],
  ['terminal.restoreFit', { terminal: 'term' }, false],
  ['terminal.getDisplayMode', { terminal: 'term' }, false],
  [
    'terminal.updateViewport',
    { terminal: 'term', client: { id: 'client' }, viewport: { cols: 80, rows: 24 } },
    false
  ],
  ['terminal.multiplex', {}, true],
  ['terminal.subscribe', { terminal: 'term' }, true],
  ['terminal.unsubscribe', { subscriptionId: 'term' }, false],
  ['terminal.getAutoRestoreFit', {}, false],
  ['terminal.setAutoRestoreFit', { ms: null }, false]
]

function schemaFor(name: string) {
  const method = TERMINAL_METHODS.find((candidate) => candidate.name === name)
  if (!method?.params) {
    throw new Error(`Missing terminal schema: ${name}`)
  }
  return method.params
}
async function invoke(name: string, params: unknown, runtime: Partial<OrcaRuntimeService>) {
  const method = TERMINAL_METHODS.find((candidate) => candidate.name === name)
  if (!method?.params || 'stream' in method) {
    throw new Error(`Missing unary terminal method: ${name}`)
  }
  return method.handler(method.params.parse(params), { runtime: runtime as OrcaRuntimeService })
}

describe('terminal RPC manifest characterization', () => {
  it('preserves all method names, order, streaming flags, and parseable minimum inputs', () => {
    expect(TERMINAL_METHODS).toHaveLength(33)
    expect(TERMINAL_METHODS.map((method) => [method.name, 'stream' in method])).toEqual(
      METHOD_CASES.map(([name, _params, stream]) => [name, stream])
    )
    expect(new Set(TERMINAL_METHODS.map((method) => method.name)).size).toBe(33)
    for (const [name, params] of METHOD_CASES) {
      expect(() => schemaFor(name).parse(params), name).not.toThrow()
    }
  })

  it('keeps legacy coercion and viewport-boundary differences', () => {
    expect(schemaFor('terminal.list').parse({ limit: 'invalid' })).toEqual({})
    expect(schemaFor('terminal.split').parse({ terminal: 'term', direction: 'diagonal' })).toEqual({
      terminal: 'term'
    })
    expect(() => schemaFor('terminal.rename').parse({ terminal: 'term' })).toThrow()
    expect(schemaFor('terminal.rename').parse({ terminal: 'term', title: '' })).toEqual({
      terminal: 'term',
      title: ''
    })
    expect(() =>
      schemaFor('terminal.updateViewport').parse({
        terminal: 'term',
        client: { id: 'client' },
        viewport: { cols: 241, rows: 120 }
      })
    ).toThrow()
    expect(() =>
      schemaFor('terminal.subscribe').parse({
        terminal: 'term',
        viewport: { cols: 1000, rows: 500 }
      })
    ).not.toThrow()
    expect(() =>
      schemaFor('terminal.setDisplayMode').parse({
        terminal: 'term',
        mode: 'auto',
        viewport: { cols: 1001, rows: 501 }
      })
    ).not.toThrow()
  })

  it('keeps multiplex control objects strict while subscribe remains skew-tolerant', () => {
    expect(TerminalMultiplexLegacyAckFrame.safeParse({ bytes: 1, future: true }).success).toBe(
      false
    )
    expect(
      TerminalMultiplexSourceRangeAckFrame.safeParse({
        streamGeneration: 'generation',
        ackedEndByte: 1,
        future: true
      }).success
    ).toBe(false)
    expect(
      TerminalMultiplexSubscribeFrame.parse({
        streamId: 1,
        terminal: 'term',
        futureCapability: 1
      })
    ).toEqual({ streamId: 1, terminal: 'term' })
  })

  it('returns execution-host authority from lifecycle handlers without reinterpretation', async () => {
    const pane = {
      handle: 'term-pane',
      executionHostId: 'ssh-host',
      hostPlatform: 'win32'
    }
    const recovered = {
      handle: 'term-recovered',
      executionHostId: 'folder-host',
      hostPlatform: 'linux'
    }
    const shown = {
      handle: 'term-shown',
      executionHostId: 'ssh-host',
      hostPlatform: 'win32'
    }
    const split = {
      handle: 'term-split',
      executionHostId: 'folder-host',
      hostPlatform: 'linux'
    }
    const runtime = {
      resolveTerminalPane: vi.fn(() => pane),
      recoverTerminalPane: vi.fn(async () => recovered),
      showTerminal: vi.fn(async () => shown),
      splitTerminal: vi.fn(async () => split)
    } as unknown as Partial<OrcaRuntimeService>

    await expect(invoke('terminal.resolvePane', { paneKey: 'pane' }, runtime)).resolves.toEqual({
      terminal: pane
    })
    await expect(
      invoke('terminal.recoverPane', { paneKey: 'pane', worktreeId: 'folder-worktree' }, runtime)
    ).resolves.toEqual({ terminal: recovered })
    await expect(invoke('terminal.show', { terminal: 'term' }, runtime)).resolves.toEqual({
      terminal: shown
    })
    await expect(invoke('terminal.split', { terminal: 'term' }, runtime)).resolves.toEqual({
      split
    })
  })

  it('keeps remote and folder selectors opaque through terminal.create', async () => {
    const created = {
      handle: 'term-created',
      executionHostId: 'ssh-host',
      hostPlatform: 'win32'
    }
    const createTerminal = vi.fn(async () => created)
    const runtime = {
      dedupeTerminalCreate: vi.fn(
        async (
          _owner: string,
          selector: string | undefined,
          _mutationId: string | undefined,
          _reconcile: boolean,
          create: (selector: string | undefined, preAllocatedHandle?: string) => Promise<unknown>
        ) => create(selector, 'term-preallocated')
      ),
      createTerminal
    } as unknown as Partial<OrcaRuntimeService>
    const selector = 'ssh://windows-host/C:/Users/dev/repo'

    await expect(
      invoke(
        'terminal.create',
        { worktree: selector, clientMutationId: 'mutation', command: 'provider resume-token' },
        runtime
      )
    ).resolves.toEqual({ terminal: created })
    expect(createTerminal).toHaveBeenCalledWith(
      selector,
      expect.objectContaining({
        command: 'provider resume-token',
        preAllocatedHandle: 'term-preallocated'
      })
    )
  })
})
