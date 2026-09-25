import { describe, expect, it, vi } from 'vitest'
import {
  replayOpenDocuments,
  reconnectVerdict,
  type RetainedOpenDocument
} from './lsp-reconnect-replay'

describe('LSP reconnect replay', () => {
  it('replays didOpen for every retained document in insertion order', () => {
    const didOpen = vi.fn()
    const session = { didOpen }
    const docs: RetainedOpenDocument[] = [
      { filePath: '/r/a.cpp', text: 'int a;', version: 3 },
      { filePath: '/r/b.cpp', text: 'int b;', version: 5 }
    ]
    const count = replayOpenDocuments(session, docs)
    expect(count).toBe(2)
    expect(didOpen).toHaveBeenCalledTimes(2)
    expect(didOpen).toHaveBeenNthCalledWith(1, '/r/a.cpp', 'int a;')
    expect(didOpen).toHaveBeenNthCalledWith(2, '/r/b.cpp', 'int b;')
  })

  it('replays zero documents for an empty retained set', () => {
    const didOpen = vi.fn()
    expect(replayOpenDocuments({ didOpen }, [])).toBe(0)
    expect(didOpen).not.toHaveBeenCalled()
  })

  it('reconnect verdict maps a clean exit (null) to clean', () => {
    expect(reconnectVerdict(null)).toBe('clean')
  })

  it('reconnect verdict maps a CONNECTION_LOST error to unverifiable (never exited)', () => {
    const lost = Object.assign(new Error('lost'), { code: 'CONNECTION_LOST' })
    expect(reconnectVerdict(lost)).toBe('unverifiable')
  })

  it('reconnect verdict maps a SshLspTransportLostError to unverifiable', () => {
    const lost = Object.assign(new Error('lost'), { name: 'SshLspTransportLostError' })
    expect(reconnectVerdict(lost)).toBe('unverifiable')
  })

  it('reconnect verdict maps a host-acknowledged exit to exited', () => {
    const exited = Object.assign(new Error('clangd exited code=1'), { code: 'EXITED' })
    expect(reconnectVerdict(exited)).toBe('exited')
  })

  it('replay re-establishes the document table so navigation recovers after reconnect', () => {
    // Simulate: a session died (transport lost), respawn reopens two docs.
    const opened: string[] = []
    const session = {
      didOpen: (filePath: string, text: string) => {
        opened.push(`${filePath}:${text}`)
      }
    }
    replayOpenDocuments(session, [
      { filePath: '/r/a.cpp', text: 'int a;', version: 1 },
      { filePath: '/r/b.cpp', text: 'int b;', version: 1 }
    ])
    expect(opened).toEqual(['/r/a.cpp:int a;', '/r/b.cpp:int b;'])
  })
})
