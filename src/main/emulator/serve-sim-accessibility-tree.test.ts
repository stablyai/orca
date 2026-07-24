import { beforeEach, describe, expect, it, vi } from 'vitest'

const { netFetchMock } = vi.hoisted(() => ({ netFetchMock: vi.fn() }))

vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))

import { requestServeSimAccessibilityTree } from './serve-sim-accessibility-tree'

const AX_URL = 'http://127.0.0.1:3100/ax'

describe('requestServeSimAccessibilityTree', () => {
  beforeEach(() => {
    netFetchMock.mockReset()
  })

  it('fetches the one-shot JSON tree and returns it normalized to 0..1', async () => {
    const raw = [
      {
        type: 'Application',
        role_description: 'application',
        AXLabel: 'Root',
        enabled: true,
        frame: { x: 0, y: 0, width: 200, height: 400 },
        children: [
          {
            type: 'Button',
            role_description: 'button',
            AXLabel: 'OK',
            enabled: true,
            frame: { x: 50, y: 100, width: 100, height: 40 },
            children: []
          }
        ]
      }
    ]
    netFetchMock.mockResolvedValue(new Response(JSON.stringify(raw), { status: 200 }))

    const tree = await requestServeSimAccessibilityTree(AX_URL)

    expect(tree).toEqual([
      {
        role: 'application',
        type: 'Application',
        label: 'Root',
        value: '',
        enabled: true,
        frame: { x: 0, y: 0, width: 1, height: 1 },
        children: [
          {
            role: 'button',
            type: 'Button',
            label: 'OK',
            value: '',
            enabled: true,
            frame: { x: 0.25, y: 0.25, width: 0.5, height: 0.1 },
            children: []
          }
        ]
      }
    ])
    expect(netFetchMock).toHaveBeenCalledWith(
      AX_URL,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
  })

  it('surfaces a retry hint when accessibility is temporarily unavailable (503)', async () => {
    netFetchMock.mockResolvedValue(new Response('{"error":"ax_unavailable"}', { status: 503 }))

    await expect(requestServeSimAccessibilityTree(AX_URL)).rejects.toMatchObject({
      code: 'emulator_helper_failed',
      message: expect.stringContaining('retry')
    })
  })

  it('rejects a non-array or unparseable payload', async () => {
    netFetchMock.mockResolvedValueOnce(new Response('{"not":"an array"}', { status: 200 }))
    await expect(requestServeSimAccessibilityTree(AX_URL)).rejects.toMatchObject({
      code: 'emulator_error'
    })

    netFetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }))
    await expect(requestServeSimAccessibilityTree(AX_URL)).rejects.toMatchObject({
      code: 'emulator_error'
    })
  })

  it('maps a network failure to a helper error', async () => {
    netFetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'))

    await expect(requestServeSimAccessibilityTree(AX_URL)).rejects.toMatchObject({
      code: 'emulator_helper_failed',
      message: expect.stringContaining('Unable to read serve-sim AX')
    })
  })
})
