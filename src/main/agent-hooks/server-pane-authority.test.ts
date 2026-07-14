import { describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer, PANE_KEY_ALIASES_MAX } from './server'

const SOURCE = makePaneKey('tab-source', '11111111-1111-4111-8111-111111111111')
const TARGET = makePaneKey('tab-target', '22222222-2222-4222-8222-222222222222')
const FINAL = makePaneKey('tab-final', '33333333-3333-4333-8333-333333333333')
const SIBLING = makePaneKey('tab-target', '44444444-4444-4444-8444-444444444444')

describe('AgentHookServer pane authority', () => {
  it('keeps physical hooks routed after the source tab closes and suppresses them after owner retire', () => {
    const server = new AgentHookServer()
    server.ingestTerminalStatus({
      paneKey: SOURCE,
      tabId: 'tab-source',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: 'source' }
    })

    server.transferPaneAuthority(SOURCE, TARGET, 'pty-1')
    server.dropStatusEntriesByTabPrefix('tab-source')
    server.ingestTerminalStatus({
      paneKey: SOURCE,
      tabId: 'tab-source',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: 'after source close' }
    })

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: TARGET,
        tabId: 'tab-target',
        prompt: 'after source close'
      })
    ])

    server.ingestTerminalStatus({
      paneKey: SIBLING,
      tabId: 'tab-target',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: 'sibling' }
    })
    server.retirePaneAuthority(TARGET)
    server.ingestTerminalStatus({
      paneKey: SOURCE,
      tabId: 'tab-source',
      worktreeId: 'wt-1',
      payload: { state: 'done', prompt: 'too late' }
    })

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: SIBLING, prompt: 'sibling' })
    ])
  })

  it('persists one physical alias while chained transfers advance its owner', () => {
    const server = new AgentHookServer()
    const listener = vi.fn()
    server.setPaneKeyAliasPersistenceListener(listener)

    server.transferPaneAuthority(SOURCE, TARGET, 'pty-1', 10)
    server.transferPaneAuthority(TARGET, FINAL, 'pty-1', 20)

    expect(listener).toHaveBeenLastCalledWith([
      {
        legacyPaneKey: SOURCE,
        stablePaneKey: FINAL,
        ptyId: 'pty-1',
        updatedAt: 20
      }
    ])
  })

  it('requires live PTY ownership for a first transfer and trusts the chained alias afterward', () => {
    const server = new AgentHookServer()

    server.ingestTerminalStatus({
      paneKey: SOURCE,
      tabId: 'tab-source',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: 'unverified source' }
    })

    expect(server.canTransferPaneAuthority(SOURCE, undefined, () => false)).toBe(false)
    expect(server.canTransferPaneAuthority(SOURCE, 'pty-1', () => false)).toBe(false)
    expect(
      server.canTransferPaneAuthority(SOURCE, 'pty-1', (paneKey, ptyId) => {
        return paneKey === SOURCE && ptyId === 'pty-1'
      })
    ).toBe(true)

    server.transferPaneAuthority(SOURCE, TARGET, 'pty-1')
    expect(server.canTransferPaneAuthority(TARGET, undefined, () => false)).toBe(true)
    expect(server.canTransferPaneAuthority(TARGET, 'pty-1', () => false)).toBe(true)
    expect(server.canTransferPaneAuthority(TARGET, 'other-pty', () => false)).toBe(false)
  })

  it('does not treat registered or restored aliases as verified authority', () => {
    const registered = new AgentHookServer()
    registered.registerPaneKeyAlias('tab-source:0', SOURCE, 'pty-1')

    expect(registered.canTransferPaneAuthority(SOURCE, undefined, () => false)).toBe(false)
    expect(registered.canTransferPaneAuthority(SOURCE, 'pty-1', () => false)).toBe(false)
    expect(
      registered.canTransferPaneAuthority(SOURCE, 'pty-1', (paneKey, ptyId) => {
        return paneKey === 'tab-source:0' && ptyId === 'pty-1'
      })
    ).toBe(true)

    const restored = new AgentHookServer()
    restored.transferPaneAuthority(SOURCE, TARGET, 'pty-1', 10, { authorityVerified: false })
    expect(restored.canTransferPaneAuthority(TARGET, undefined, () => false)).toBe(false)
    expect(restored.canTransferPaneAuthority(TARGET, 'pty-1', () => false)).toBe(false)
    expect(
      restored.canTransferPaneAuthority(TARGET, 'pty-1', (paneKey, ptyId) => {
        return paneKey === TARGET && ptyId === 'pty-1'
      })
    ).toBe(true)
    restored.transferPaneAuthority(TARGET, FINAL, 'pty-1', 20)
    expect(restored.canTransferPaneAuthority(FINAL, undefined, () => false)).toBe(true)
  })

  it('prefers a spawn-verified legacy alias over an earlier migration fallback', () => {
    const server = new AgentHookServer()
    server.registerPaneKeyAlias('tab-source:0', SOURCE, 'pty-1')
    server.registerPaneKeyAlias('tab-source:1', SOURCE, 'pty-1', 20, {
      authorityVerified: true
    })

    expect(server.canTransferPaneAuthority(SOURCE, undefined, () => false)).toBe(true)
    expect(server.canTransferPaneAuthority(SOURCE, 'pty-1', () => false)).toBe(true)
  })

  it('bounds persisted aliases by evicting the oldest authority', () => {
    const server = new AgentHookServer()
    const listener = vi.fn()
    server.setPaneKeyAliasPersistenceListener(listener)

    for (let index = 0; index <= PANE_KEY_ALIASES_MAX; index += 1) {
      const suffix = index.toString(16).padStart(12, '0')
      server.transferPaneAuthority(
        makePaneKey(`source-${index}`, `00000000-0000-4000-8000-${suffix}`),
        makePaneKey(`target-${index}`, `10000000-0000-4000-8000-${suffix}`),
        `pty-${index}`,
        index + 1
      )
    }

    const persisted = listener.mock.calls.at(-1)?.[0]
    expect(persisted).toHaveLength(PANE_KEY_ALIASES_MAX)
    expect(persisted).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ legacyPaneKey: expect.stringContaining('source-0:') })
      ])
    )
  })
})
