import { describe, expect, it } from 'vitest'
import {
  claimOrcaPaneBinding,
  findUniqueHerdrMatch,
  ORCA_BINDING_TOKEN,
  orcaPaneBinding,
  orcaWorkspaceBinding,
  reclaimExclusiveOrcaPaneBinding,
  recoverPaneIdsFromStockLayout,
  restoreOrcaPaneBindings
} from './herdr-binding-metadata'
import type {
  HerdrHostTransport,
  HerdrPane,
  HerdrResponse,
  HerdrSessionSnapshot
} from './herdr-runtime-contract'

describe('stock Herdr metadata bindings', () => {
  it('uses stable token-sized digests for Orca resources', () => {
    const workspace = orcaWorkspaceBinding('project-1', {
      id: 'worktree-1',
      instanceId: 'instance-1',
      path: '/repo',
      displayName: 'repo'
    })
    expect(workspace).toHaveLength(64)
    expect(orcaPaneBinding('project-1', 'leaf-1')).toHaveLength(64)
    expect(workspace).not.toBe(orcaPaneBinding('project-1', 'leaf-1'))
  })

  it('refuses ambiguous adoption candidates', () => {
    expect(() => findUniqueHerdrMatch([1, 2], () => true, 'workspace checkout')).toThrow(
      'Orca will not guess'
    )
  })

  it('recovers pane identities from stock layout geometry after token loss', () => {
    const recovered = recoverPaneIdsFromStockLayout(
      {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        first: { type: 'leaf', leafId: 'left' },
        second: { type: 'leaf', leafId: 'right' }
      },
      {
        workspace_id: 'w1',
        tab_id: 'w1:t1',
        panes: [
          {
            pane_id: 'w1:p2',
            rect: { x: 60, y: 0, width: 60, height: 40 }
          },
          {
            pane_id: 'w1:p1',
            rect: { x: 0, y: 0, width: 60, height: 40 }
          }
        ]
      }
    )
    expect(Object.fromEntries(recovered ?? [])).toEqual({
      left: 'w1:p1',
      right: 'w1:p2'
    })
  })

  it('rejects layout geometry that does not match the expected split axis', () => {
    const recovered = recoverPaneIdsFromStockLayout(
      {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        first: { type: 'leaf', leafId: 'left' },
        second: { type: 'leaf', leafId: 'right' }
      },
      {
        workspace_id: 'w1',
        tab_id: 'w1:t1',
        panes: [
          {
            pane_id: 'w1:p1',
            rect: { x: 0, y: 0, width: 120, height: 20 }
          },
          {
            pane_id: 'w1:p2',
            rect: { x: 0, y: 20, width: 120, height: 20 }
          }
        ]
      }
    )
    expect(recovered).toBeNull()
  })

  it('recovers pane identities from valid nested split geometry', () => {
    const recovered = recoverPaneIdsFromStockLayout(
      {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        first: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', leafId: 'tl' },
          second: { type: 'leaf', leafId: 'bl' }
        },
        second: { type: 'leaf', leafId: 'right' }
      },
      {
        workspace_id: 'w1',
        tab_id: 'w1:t1',
        panes: [
          { pane_id: 'w1:p1', rect: { x: 0, y: 0, width: 60, height: 20 } },
          { pane_id: 'w1:p2', rect: { x: 0, y: 20, width: 60, height: 20 } },
          { pane_id: 'w1:p3', rect: { x: 60, y: 0, width: 60, height: 40 } }
        ]
      }
    )
    expect(recovered).not.toBeNull()
    const map = Object.fromEntries(recovered ?? [])
    expect(map.right).toBe('w1:p3')
    expect(['w1:p1', 'w1:p2'].sort()).toEqual([map.tl, map.bl].sort())
  })

  it('keeps persisted pane IDs when geometry recovery fails instead of dropping all bindings', async () => {
    // vertical split expected, but the persisted layout is horizontal -> recoverPaneIdsFromStockLayout returns null.
    const root = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.5,
      first: { type: 'leaf', leafId: 'left' },
      second: { type: 'leaf', leafId: 'right' }
    } as const
    const snapshot = {
      version: '1',
      protocol: 18,
      workspaces: [],
      tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', title: 'tab' }],
      panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', tokens: {} }],
      layouts: [
        {
          workspace_id: 'w1',
          tab_id: 'w1:t1',
          panes: [{ pane_id: 'w1:p1', rect: { x: 0, y: 0, width: 120, height: 20 } }]
        }
      ],
      agents: []
    }
    const reportCalls: { paneId: string; binding: string }[] = []
    const transport: HerdrHostTransport = {
      ensureSession: async () => {},
      request: async <T>(_s: string, _m: string, params: unknown): Promise<HerdrResponse<T>> => {
        const p = params as { pane_id: string; tokens?: Record<string, string> }
        reportCalls.push({ paneId: p.pane_id, binding: p.tokens?.orca_binding ?? '' })
        return { id: '1', result: { type: 'ok' } as unknown as T }
      }
    }

    await restoreOrcaPaneBindings(
      transport,
      'orca-app',
      'project-1',
      root,
      'w1:t1',
      snapshot as never,
      { left: 'w1:p1' }
    )

    // The persisted pane id survives the geometric recovery failure and is re-reported.
    expect(reportCalls).toHaveLength(1)

    expect(reportCalls[0]).toEqual({
      paneId: 'w1:p1',
      binding: orcaPaneBinding('project-1', 'left')
    })
  })

  it('reclaims a duplicate pane token onto the persisted pane and clears the rest', async () => {
    const binding = orcaPaneBinding('project-1', 'leaf-a')
    const cleared: string[] = []
    const transport: HerdrHostTransport = {
      ensureSession: async () => {},
      request: async <T>(_s: string, _m: string, params: unknown): Promise<HerdrResponse<T>> => {
        const input = params as { pane_id: string; tokens?: Record<string, string | null> }
        if (input.tokens?.[ORCA_BINDING_TOKEN] === null) {
          cleared.push(input.pane_id)
        }
        return { id: '1', result: { type: 'ok' } as unknown as T }
      }
    }
    const snapshot: HerdrSessionSnapshot = {
      version: '1',
      protocol: 1,
      workspaces: [],
      tabs: [],
      panes: [
        {
          pane_id: 'w7:p2',
          tab_id: 'w7:t2',
          workspace_id: 'w7',
          tokens: { [ORCA_BINDING_TOKEN]: binding }
        },
        {
          pane_id: 'w7:p1',
          tab_id: 'w7:t1',
          workspace_id: 'w7',
          tokens: { [ORCA_BINDING_TOKEN]: binding }
        }
      ],
      layouts: [],
      agents: []
    }

    const winner = await reclaimExclusiveOrcaPaneBinding(transport, 'orca', snapshot, binding, {
      preferredPaneId: 'w7:p1',
      workspaceId: 'w7'
    })

    expect(winner?.pane_id).toBe('w7:p1')
    expect(cleared).toEqual(['w7:p2'])
    expect(
      snapshot.panes.find((pane) => pane.pane_id === 'w7:p2')?.tokens?.[ORCA_BINDING_TOKEN]
    ).toBeUndefined()
    expect(
      snapshot.panes.find((pane) => pane.pane_id === 'w7:p1')?.tokens?.[ORCA_BINDING_TOKEN]
    ).toBe(binding)
  })

  it('claims a free binding once and refuses to double-claim it on another live pane', async () => {
    const reportCalls: string[] = []
    const transport: HerdrHostTransport = {
      ensureSession: async () => {},
      request: async <T>(_s: string, _m: string, params: unknown): Promise<HerdrResponse<T>> => {
        reportCalls.push((params as { pane_id: string }).pane_id)
        return { id: '1', result: { type: 'ok' } as unknown as T }
      }
    }
    const snapshot: HerdrSessionSnapshot = {
      version: '1',
      protocol: 1,
      workspaces: [],
      tabs: [],
      panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' }],
      layouts: [],
      agents: []
    }
    const owner = snapshot.panes[0]
    await claimOrcaPaneBinding(transport, 'shared', 'project-1', 'leaf-a', owner, snapshot)
    const imposter: HerdrPane = { pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1' }
    await claimOrcaPaneBinding(transport, 'shared', 'project-1', 'leaf-a', imposter, snapshot)

    const binding = orcaPaneBinding('project-1', 'leaf-a')
    expect(reportCalls).toEqual(['w1:p1'])
    expect(owner.tokens?.[ORCA_BINDING_TOKEN]).toBe(binding)
    expect(imposter.tokens?.[ORCA_BINDING_TOKEN]).toBeUndefined()
    expect(
      snapshot.panes.filter((pane) => pane.tokens?.[ORCA_BINDING_TOKEN] === binding)
    ).toHaveLength(1)
  })

  it('lets a pane change its binding to another leaf only when that leaf is unclaimed', async () => {
    const reportCalls: string[] = []
    const transport: HerdrHostTransport = {
      ensureSession: async () => {},
      request: async <T>(_s: string, _m: string, params: unknown): Promise<HerdrResponse<T>> => {
        reportCalls.push((params as { pane_id: string }).pane_id)
        return { id: '1', result: { type: 'ok' } as unknown as T }
      }
    }
    const snapshot: HerdrSessionSnapshot = {
      version: '1',
      protocol: 2,
      workspaces: [],
      tabs: [],
      panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' }],
      layouts: [],
      agents: []
    }
    const pane = snapshot.panes[0]

    await claimOrcaPaneBinding(transport, 's', 'project-1', 'leaf-a', pane, snapshot)
    const bindingA = orcaPaneBinding('project-1', 'leaf-a')

    // Re-claiming the same pane for the same leaf is a no-op.
    await claimOrcaPaneBinding(transport, 's', 'project-1', 'leaf-a', pane, snapshot)
    expect(reportCalls).toEqual(['w1:p1'])
    expect(pane.tokens?.[ORCA_BINDING_TOKEN]).toBe(bindingA)

    // Moving the same pane to a different, unclaimed leaf is allowed.
    await claimOrcaPaneBinding(transport, 's', 'project-1', 'leaf-b', pane, snapshot)
    expect(reportCalls).toEqual(['w1:p1', 'w1:p1'])
    expect(pane.tokens?.[ORCA_BINDING_TOKEN]).toBe(orcaPaneBinding('project-1', 'leaf-b'))
    expect(
      snapshot.panes.filter((candidate) => candidate.tokens?.[ORCA_BINDING_TOKEN] === bindingA)
    ).toHaveLength(0)
  })
})
