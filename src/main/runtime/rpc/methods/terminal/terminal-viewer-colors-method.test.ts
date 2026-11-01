import '../../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { RpcDispatcher } from '../../dispatcher'
import { TERMINAL_METHODS } from '../terminal'
import {
  _resetTerminalViewAttributesForTest,
  getTerminalViewAttributes,
  getTerminalViewerColors,
  setTerminalViewAttributes,
  setTerminalViewerColorsListener
} from '../../../terminal-view-attribute-store'
import type {
  TerminalViewAttributes,
  TerminalViewRgb
} from '../../../../../shared/terminal-view-attributes'

function appearance(background: TerminalViewRgb): TerminalViewAttributes {
  return {
    foreground: [0x2e, 0x34, 0x34],
    background,
    cursor: [0x2e, 0x34, 0x34],
    ansi: Array.from({ length: 256 }, (_, i): TerminalViewRgb => [i, i, i]),
    colorSchemeMode: 'light',
    cursorStyle: 'bar',
    cursorBlink: false
  }
}

function dispatcher(): RpcDispatcher {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads nothing from the runtime; the dispatcher needs only its id.
  const runtime = { getRuntimeId: () => 'runtime-1' } as unknown as OrcaRuntimeService
  return new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
}

function setViewerColors(params: unknown) {
  return dispatcher().dispatch({
    id: 'viewer-colors-1',
    authToken: 'token',
    method: 'terminal.setViewerColors',
    params
  })
}

describe('terminal.setViewerColors', () => {
  afterEach(() => _resetTerminalViewAttributesForTest())

  it("makes a paired client's colours the ones a headless host answers with", async () => {
    const published: unknown[] = []
    setTerminalViewerColorsListener((colors) => published.push(colors))
    const colors = { foreground: '#2e3434', background: '#ffffff' }

    const response = await setViewerColors({ colors })

    expect(response).toMatchObject({ ok: true, result: { applied: true } })
    expect(getTerminalViewerColors()).toEqual(colors)
    expect(published).toEqual([colors])
  })

  it('keeps the current colours when the pair cannot answer both slots', async () => {
    const response = await setViewerColors({ colors: { foreground: '#ffffff' } })

    expect(response).toMatchObject({ ok: true, result: { applied: false } })
    expect(getTerminalViewerColors()).toBeNull()
  })

  it('ignores members a newer client adds', async () => {
    const colors = { foreground: '#000000', background: '#ffffff' }

    const response = await setViewerColors({ colors: { ...colors, cursor: '#ff0000' }, seq: 3 })

    expect(response).toMatchObject({ ok: true, result: { applied: true } })
    expect(getTerminalViewerColors()).toEqual(colors)
  })

  it("gives a windowless host the paired client's palette for hidden OSC 4/12 and ?996n replies", async () => {
    const attributes = appearance([0xff, 0xff, 0xff])

    await setViewerColors({ colors: { foreground: '#2e3434', background: '#ffffff' }, attributes })

    expect(getTerminalViewAttributes()).toEqual(attributes)
  })

  it("keeps a windowed host's own palette", async () => {
    const own = appearance([0x28, 0x2c, 0x34])
    setTerminalViewAttributes(own)

    await setViewerColors({
      colors: { foreground: '#2e3434', background: '#ffffff' },
      attributes: appearance([0xff, 0xff, 0xff])
    })

    expect(getTerminalViewAttributes()).toEqual(own)
  })

  it('drops a malformed palette but still applies the colours', async () => {
    const colors = { foreground: '#2e3434', background: '#ffffff' }

    await setViewerColors({ colors, attributes: { ...appearance([1, 2, 3]), ansi: [] } })

    expect(getTerminalViewAttributes()).toBeNull()
    expect(getTerminalViewerColors()).toEqual(colors)
  })

  it("forgets an earlier client's palette when an older client pushes colours only", async () => {
    await setViewerColors({
      colors: { foreground: '#ffffff', background: '#282c34' },
      attributes: appearance([0x28, 0x2c, 0x34])
    })

    await setViewerColors({ colors: { foreground: '#2e3434', background: '#ffffff' } })

    // A dark palette beside light OSC 10/11 would contradict; hidden palette queries go silent instead.
    expect(getTerminalViewAttributes()).toBeNull()
  })
})
