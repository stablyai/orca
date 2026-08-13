import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalViewAttributes, TerminalViewRgb } from '../../shared/terminal-view-attributes'
import {
  _resetTerminalViewAttributesForTest,
  commitTerminalViewAttributesSnapshot,
  getTerminalViewAttributes,
  hasRendererCommittedSnapshot,
  markRendererCommittedSnapshot,
  registerTerminalViewAttributesApplier
} from './terminal-view-attribute-store'

function attrs(background: TerminalViewRgb): TerminalViewAttributes {
  return {
    foreground: [0xff, 0xff, 0xff],
    background,
    cursor: [0xff, 0xff, 0xff],
    ansi: Array.from({ length: 256 }, () => [0, 0, 0] as TerminalViewRgb),
    colorSchemeMode: 'dark',
    cursorStyle: 'block',
    cursorBlink: false
  }
}

const GLOBAL = attrs([0x28, 0x2c, 0x34])
const CODEX = attrs([0x11, 0x00, 0x00])
const LIGHT_GLOBAL = attrs([0xfa, 0xfa, 0xfa])

beforeEach(() => {
  _resetTerminalViewAttributesForTest()
})

describe('terminal-view-attribute-store snapshot', () => {
  it('looks up global, agent override, and inherit fallback', () => {
    commitTerminalViewAttributesSnapshot({
      global: GLOBAL,
      byAgent: { codex: CODEX }
    })
    expect(getTerminalViewAttributes(null)?.background).toEqual(GLOBAL.background)
    expect(getTerminalViewAttributes('codex')?.background).toEqual(CODEX.background)
    expect(getTerminalViewAttributes('claude')?.background).toEqual(GLOBAL.background)
  })

  it('does not fan out an identical re-push', () => {
    const applier = vi.fn()
    registerTerminalViewAttributesApplier(applier)
    commitTerminalViewAttributesSnapshot({ global: GLOBAL, byAgent: { codex: CODEX } })
    applier.mockClear()
    commitTerminalViewAttributesSnapshot({ global: GLOBAL, byAgent: { codex: CODEX } })
    expect(applier).not.toHaveBeenCalled()
  })

  it('does not apply when adding a Codex override equal to global', () => {
    const applier = vi.fn()
    registerTerminalViewAttributesApplier(applier)
    commitTerminalViewAttributesSnapshot({ global: GLOBAL, byAgent: {} })
    applier.mockClear()
    commitTerminalViewAttributesSnapshot({ global: GLOBAL, byAgent: { codex: GLOBAL } })
    expect(applier).not.toHaveBeenCalled()
  })

  it('does not apply when removing a same-as-global Codex override back to inherit', () => {
    const applier = vi.fn()
    registerTerminalViewAttributesApplier(applier)
    commitTerminalViewAttributesSnapshot({ global: GLOBAL, byAgent: { codex: GLOBAL } })
    applier.mockClear()
    commitTerminalViewAttributesSnapshot({ global: GLOBAL, byAgent: {} })
    expect(applier).not.toHaveBeenCalled()
  })

  it('applies global only to Codex when removing a different Codex override', () => {
    const applier = vi.fn()
    registerTerminalViewAttributesApplier(applier)
    commitTerminalViewAttributesSnapshot({ global: GLOBAL, byAgent: { codex: CODEX } })
    applier.mockClear()
    commitTerminalViewAttributesSnapshot({ global: GLOBAL, byAgent: {} })
    expect(applier).toHaveBeenCalledTimes(1)
    expect(applier).toHaveBeenCalledWith(GLOBAL, { launchAgent: 'codex' })
  })

  it('does not fan out a Codex-only change to the shell/global scope', () => {
    const applier = vi.fn()
    registerTerminalViewAttributesApplier(applier)
    commitTerminalViewAttributesSnapshot({ global: GLOBAL, byAgent: {} })
    applier.mockClear()
    commitTerminalViewAttributesSnapshot({ global: GLOBAL, byAgent: { codex: CODEX } })
    expect(applier).toHaveBeenCalledTimes(1)
    expect(applier).toHaveBeenCalledWith(CODEX, { launchAgent: 'codex' })
  })

  it('replaces a stale Codex map on renderer-reload inherit snapshot', () => {
    commitTerminalViewAttributesSnapshot({ global: GLOBAL, byAgent: { codex: CODEX } })
    commitTerminalViewAttributesSnapshot({ global: GLOBAL, byAgent: {} })
    expect(getTerminalViewAttributes('codex')?.background).toEqual(GLOBAL.background)
  })

  it('commits atomically so appliers only see the new global+agent pair', () => {
    const seen: { global: TerminalViewRgb; codex: TerminalViewRgb }[] = []
    registerTerminalViewAttributesApplier(() => {
      seen.push({
        global: getTerminalViewAttributes(null)!.background,
        codex: getTerminalViewAttributes('codex')!.background
      })
    })
    commitTerminalViewAttributesSnapshot({ global: GLOBAL, byAgent: { codex: CODEX } })
    seen.length = 0
    commitTerminalViewAttributesSnapshot({
      global: LIGHT_GLOBAL,
      byAgent: { codex: CODEX }
    })
    expect(seen.length).toBeGreaterThan(0)
    for (const snapshot of seen) {
      expect(snapshot).toEqual({
        global: LIGHT_GLOBAL.background,
        codex: CODEX.background
      })
    }
  })

  it('marks renderer-committed snapshots separately from seed commits', () => {
    commitTerminalViewAttributesSnapshot({ global: GLOBAL, byAgent: {} })
    expect(hasRendererCommittedSnapshot()).toBe(false)
    markRendererCommittedSnapshot()
    expect(hasRendererCommittedSnapshot()).toBe(true)
  })
})
