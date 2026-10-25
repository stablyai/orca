import '../../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { RpcDispatcher } from '../../dispatcher'
import { TERMINAL_METHODS } from '../terminal'
import {
  _resetTerminalViewAttributesForTest,
  getTerminalViewerColors,
  setTerminalViewerColorsListener
} from '../../../terminal-view-attribute-store'

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
})
