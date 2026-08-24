import { describe, expect, it } from 'vitest'
import { resolveMobileTerminalResizePaint } from './mobile-terminal-resize-paint'

describe('resolveMobileTerminalResizePaint', () => {
  it('inits only when the resized frame carries a real snapshot', () => {
    expect(resolveMobileTerminalResizePaint('\x1b[2Jprompt')).toEqual({
      kind: 'init',
      data: '\x1b[2Jprompt'
    })
  })

  it('resizes in place when serialized is missing', () => {
    expect(resolveMobileTerminalResizePaint(undefined)).toEqual({ kind: 'resize' })
    expect(resolveMobileTerminalResizePaint(null)).toEqual({ kind: 'resize' })
  })

  it('resizes in place when serialized is an empty string', () => {
    expect(resolveMobileTerminalResizePaint('')).toEqual({ kind: 'resize' })
  })
})
