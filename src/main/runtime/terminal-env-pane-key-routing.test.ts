import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  collectMovedEnvPaneKeys,
  ownsEnvPaneKeyAlone,
  resolveTerminalPaneForEnvPaneKey,
  type EnvPaneKeyTerminal
} from './terminal-env-pane-key-routing'

const OLD = makePaneKey('tab-old', '11111111-1111-4111-8111-111111111111')
const NEW = makePaneKey('tab-new', '22222222-2222-4222-8222-222222222222')
const OTHER = makePaneKey('tab-other', '33333333-3333-4333-8333-333333333333')

type Terminal = EnvPaneKeyTerminal & { exited?: boolean; mounted?: string[] }

function source(terminals: Terminal[]) {
  return {
    terminals,
    isLive: (terminal: Terminal) => terminal.exited !== true,
    currentPaneKeys: (terminal: Terminal) => terminal.mounted ?? []
  }
}

const moved: Terminal = { ptyId: 'pty-1', paneKey: NEW, envPaneKey: OLD, connectionId: null }

describe('resolveTerminalPaneForEnvPaneKey', () => {
  it('resolves an exported key to the pane its live terminal shows now', () => {
    expect(resolveTerminalPaneForEnvPaneKey(OLD, source([moved]))).toBe(NEW)
  })

  it('prefers the mounted leaf over the recorded surface', () => {
    expect(
      resolveTerminalPaneForEnvPaneKey(OLD, source([{ ...moved, paneKey: null, mounted: [NEW] }]))
    ).toBe(NEW)
  })

  it.each<[string, Terminal[]]>([
    [
      'no terminal exported the key',
      [{ ptyId: 'pty-1', paneKey: NEW, envPaneKey: OTHER, connectionId: null }]
    ],
    [
      'the terminal never moved',
      [{ ptyId: 'pty-1', paneKey: OLD, envPaneKey: OLD, connectionId: null }]
    ],
    ['the terminal exited', [{ ...moved, exited: true }]],
    [
      'another live terminal shows that pane now',
      [moved, { ptyId: 'pty-2', paneKey: OLD, envPaneKey: OLD, connectionId: null }]
    ],
    [
      'two live terminals exported the same key',
      [moved, { ptyId: 'pty-2', paneKey: OTHER, envPaneKey: OLD, connectionId: null }]
    ],
    ['the terminal is mounted in more than one pane', [{ ...moved, mounted: [NEW, OTHER] }]],
    ['the terminal has no surface', [{ ...moved, paneKey: null }]],
    [
      'a host predating the field reported none',
      [{ ptyId: 'pty-1', paneKey: NEW, connectionId: null }]
    ]
  ])('refuses to guess when %s', (_case, terminals) => {
    expect(resolveTerminalPaneForEnvPaneKey(OLD, source(terminals))).toBeUndefined()
  })

  it('ignores an exited terminal that still records the pane', () => {
    expect(
      resolveTerminalPaneForEnvPaneKey(
        OLD,
        source([
          moved,
          { ptyId: 'pty-2', paneKey: OLD, envPaneKey: OLD, connectionId: null, exited: true }
        ])
      )
    ).toBe(NEW)
  })

  it('routes only posts from the host that runs the terminal', () => {
    const remote: Terminal = { ...moved, connectionId: 'ssh-a' }
    expect(resolveTerminalPaneForEnvPaneKey(OLD, source([remote]), 'ssh-a')).toBe(NEW)
    expect(resolveTerminalPaneForEnvPaneKey(OLD, source([remote]), 'ssh-b')).toBeUndefined()
    expect(resolveTerminalPaneForEnvPaneKey(OLD, source([remote]), null)).toBeUndefined()
  })

  it('rejects keys that are not stable pane keys', () => {
    expect(resolveTerminalPaneForEnvPaneKey('tab-old:1', source([moved]))).toBeUndefined()
  })
})

describe('collectMovedEnvPaneKeys', () => {
  it('pairs each exported key with the pane its terminal shows now, scoped to its host', () => {
    expect(
      collectMovedEnvPaneKeys(
        source([
          moved,
          { ptyId: 'pty-2', paneKey: OTHER, envPaneKey: OTHER, connectionId: null },
          { ptyId: 'pty-3', paneKey: OTHER, connectionId: null }
        ])
      )
    ).toEqual([{ fromPaneKey: OLD, toPaneKey: NEW, connectionId: null, ptyId: 'pty-1' }])
  })

  it.each<[string, Terminal[]]>([
    [
      'another live terminal shows that pane',
      [moved, { ptyId: 'pty-2', paneKey: OLD, connectionId: null }]
    ],
    [
      'another live terminal exported the same key',
      [moved, { ptyId: 'pty-2', paneKey: OTHER, envPaneKey: OLD, connectionId: null }]
    ],
    ['the terminal exited', [{ ...moved, exited: true }]],
    ['the terminal shows in two panes', [{ ...moved, mounted: [NEW, OTHER] }]]
  ])('reports no move when %s', (_case, terminals) => {
    expect(collectMovedEnvPaneKeys(source(terminals))).toEqual([])
  })

  it('keeps a key exported on two hosts apart', () => {
    const remote: Terminal = {
      ptyId: 'pty-2',
      paneKey: OTHER,
      envPaneKey: OLD,
      connectionId: 'ssh-a'
    }
    expect(collectMovedEnvPaneKeys(source([moved, remote]))).toEqual([
      { fromPaneKey: OLD, toPaneKey: NEW, connectionId: null, ptyId: 'pty-1' },
      { fromPaneKey: OLD, toPaneKey: OTHER, connectionId: 'ssh-a', ptyId: 'pty-2' }
    ])
  })
})

describe('ownsEnvPaneKeyAlone', () => {
  it('is false when another live terminal shows or exported the key', () => {
    expect(ownsEnvPaneKeyAlone(moved, source([moved]))).toBe(true)
    expect(
      ownsEnvPaneKeyAlone(
        moved,
        source([moved, { ptyId: 'pty-2', paneKey: OLD, connectionId: null }])
      )
    ).toBe(false)
    expect(
      ownsEnvPaneKeyAlone(
        moved,
        source([moved, { ptyId: 'pty-2', paneKey: OTHER, envPaneKey: OLD, connectionId: null }])
      )
    ).toBe(false)
    expect(
      ownsEnvPaneKeyAlone(
        moved,
        source([moved, { ptyId: 'pty-2', paneKey: OLD, connectionId: null, exited: true }])
      )
    ).toBe(true)
  })
})
