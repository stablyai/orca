import { describe, expect, it } from 'vitest'
import { CLIPBOARD_TEXT_WRITE_MAX_BYTES } from '../../shared/clipboard-text'
import {
  COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
  isComputerProviderSupervisorRequest,
  isSupervisedDesktopProviderResult
} from './computer-provider-supervisor-protocol'
import { DESKTOP_PROVIDER_REQUEST_MAX_BYTES } from './desktop-script-provider-request-validation'

function desktopRequest(request: Record<string, unknown>): Record<string, unknown> {
  return {
    channel: COMPUTER_PROVIDER_SUPERVISOR_CHANNEL,
    kind: 'request',
    id: 1,
    method: 'desktop.execute',
    params: { request }
  }
}

describe('computer provider supervisor protocol', () => {
  it('accepts exact desktop tool requests with validated nested element state', () => {
    expect(
      isComputerProviderSupervisorRequest(
        desktopRequest({
          tool: 'click',
          app: 'Text Editor',
          element: {
            index: 0,
            runtimeId: [42, 7],
            name: 'Save',
            frame: { x: 1, y: 2, width: 30, height: 10 },
            actions: ['invoke']
          },
          click_count: 1,
          mouse_button: 'left',
          modifiers: 'CmdOrCtrl+Shift',
          windowBounds: null
        })
      )
    ).toBe(true)
  })

  it('rejects command, path, argument, environment, and envelope injection', () => {
    for (const injected of [
      { command: 'sh' },
      { executablePath: '/tmp/provider' },
      { scriptPath: '/tmp/runtime.py' },
      { args: ['--arbitrary'] },
      { env: { PATH: '/tmp' } },
      { timeout: 1 }
    ]) {
      expect(
        isComputerProviderSupervisorRequest(desktopRequest({ tool: 'list_apps', ...injected }))
      ).toBe(false)
    }
    expect(
      isComputerProviderSupervisorRequest({
        ...desktopRequest({ tool: 'list_apps' }),
        command: 'sh'
      })
    ).toBe(false)
  })

  it('rejects malformed and incomplete action requests', () => {
    const rejected = [
      { tool: 'unknown' },
      { tool: 'click', app: 'Text Editor' },
      { tool: 'click', app: 'Text Editor', x: 1 },
      { tool: 'click', app: 'Text Editor', x: Number.NaN, y: 2 },
      { tool: 'click', app: 'Text Editor', x: 1, y: 2, modifiers: 'A' },
      { tool: 'scroll', app: 'Text Editor', x: 1, y: 2, direction: 'diagonal' },
      {
        tool: 'drag',
        app: 'Text Editor',
        from_x: 1,
        from_y: 2,
        to_x: 3
      },
      {
        tool: 'set_value',
        app: 'Text Editor',
        element: { index: -1 },
        value: 'draft'
      },
      {
        tool: 'click',
        app: 'Text Editor',
        element: { index: 0, runtimeId: [1, 'untrusted'] }
      },
      {
        tool: 'get_app_state',
        app: 'Text Editor',
        windowId: 1,
        windowIndex: 2
      }
    ]
    for (const request of rejected) {
      expect(isComputerProviderSupervisorRequest(desktopRequest(request))).toBe(false)
    }
  })

  it('enforces the existing paste limit independently of the envelope cap', () => {
    const text = 'x'.repeat(CLIPBOARD_TEXT_WRITE_MAX_BYTES + 1)

    expect(
      isComputerProviderSupervisorRequest(
        desktopRequest({ tool: 'paste_text', app: 'Text Editor', text })
      )
    ).toBe(false)
  })

  it('rejects oversized and non-serializable requests', () => {
    expect(
      isComputerProviderSupervisorRequest(
        desktopRequest({
          tool: 'type_text',
          app: 'Text Editor',
          text: 'x'.repeat(DESKTOP_PROVIDER_REQUEST_MAX_BYTES)
        })
      )
    ).toBe(false)

    const cyclic = { tool: 'get_app_state' } as Record<string, unknown>
    cyclic.app = cyclic
    expect(isComputerProviderSupervisorRequest(desktopRequest(cyclic))).toBe(false)
  })

  it('validates exact desktop result shapes', () => {
    expect(
      isSupervisedDesktopProviderResult({
        stdout: '{"ok":true}',
        stderr: '',
        error: null
      })
    ).toBe(true)
    expect(
      isSupervisedDesktopProviderResult({
        stdout: '',
        stderr: 'failed',
        error: { message: 'failed', killed: false }
      })
    ).toBe(true)
    expect(
      isSupervisedDesktopProviderResult({
        stdout: '',
        stderr: '',
        error: null,
        command: 'sh'
      })
    ).toBe(false)
  })
})
