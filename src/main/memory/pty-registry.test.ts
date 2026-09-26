import { describe, expect, it } from 'vitest'

import { listRegisteredPtys, notePtyInput, registerPty, unregisterPty } from './pty-registry'

function registration(ptyId: string) {
  return { ptyId, worktreeId: null, sessionId: null, paneKey: 'tab:leaf', pid: 1 }
}

describe('notePtyInput', () => {
  it('stamps the registration it was asked about', () => {
    const ptyId = 'pty-note-input-stamp'
    registerPty(registration(ptyId))
    try {
      notePtyInput(ptyId, 1_700_000_000_000)
      expect(find(ptyId)?.lastInputAtMs).toBe(1_700_000_000_000)
    } finally {
      unregisterPty(ptyId)
    }
  })

  it('ignores a pty the registry never learned', () => {
    notePtyInput('pty-never-registered', 1_700_000_000_000)
    expect(find('pty-never-registered')).toBeUndefined()
    expect(listRegisteredPtys().some((pty) => pty.ptyId === 'pty-never-registered')).toBe(false)
  })

  it('keeps the stamp it replaces so a submission survives later typing', () => {
    const ptyId = 'pty-note-input-history'
    registerPty(registration(ptyId))
    try {
      notePtyInput(ptyId, 1_000)
      notePtyInput(ptyId, 2_000)
      expect(find(ptyId)?.lastInputAtMs).toBe(2_000)
      expect(find(ptyId)?.previousInputAtMs).toBe(1_000)
    } finally {
      unregisterPty(ptyId)
    }
  })

  it('drops the stamp with the registration', () => {
    const ptyId = 'pty-note-input-teardown'
    registerPty(registration(ptyId))
    notePtyInput(ptyId, 1_700_000_000_000)
    unregisterPty(ptyId)
    expect(find(ptyId)).toBeUndefined()
  })
})

function find(ptyId: string) {
  return listRegisteredPtys().find((pty) => pty.ptyId === ptyId)
}
