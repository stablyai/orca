import { describe, expect, it, vi } from 'vitest'
import type { ComputerProviderCapabilities } from '../../../shared/computer-use-runtime-types'
import { launchBridgeApp } from './desktop-script-apps'

function capabilities(launch: boolean | undefined): ComputerProviderCapabilities {
  return {
    platform: 'linux',
    provider: 'orca-computer-use-linux',
    providerVersion: '1.0.0',
    protocolVersion: 1,
    supports: {
      apps: {
        list: true,
        bundleIds: false,
        pids: true,
        ...(launch === undefined ? {} : { launch })
      },
      windows: {
        list: true,
        targetById: true,
        targetByIndex: true,
        focus: false,
        moveResize: false
      },
      observation: {
        screenshot: true,
        annotatedScreenshot: false,
        elementFrames: true,
        ocr: false
      },
      actions: {
        click: true,
        typeText: true,
        pressKey: true,
        hotkey: true,
        pasteText: true,
        scroll: true,
        drag: true,
        setValue: true,
        performAction: true
      },
      surfaces: { menus: false, dialogs: false, dock: false, menubar: false }
    }
  }
}

describe('launchBridgeApp', () => {
  it('refuses before starting anything when the provider cannot launch in the background', async () => {
    const callBridge = vi.fn()

    await expect(
      launchBridgeApp(capabilities(undefined), callBridge, { app: 'gedit' })
    ).rejects.toMatchObject({ code: 'unsupported_capability' })
    expect(callBridge).not.toHaveBeenCalled()
  })

  it('reports what the provider measured, not what was asked', async () => {
    const callBridge = vi.fn(async () => ({
      ok: true,
      app: { name: 'charmap', bundleId: 'charmap', pid: 42 },
      launched: true,
      delivery: 'foreground' as const
    }))

    await expect(
      launchBridgeApp(capabilities(true), callBridge, { app: 'charmap' })
    ).resolves.toEqual({
      app: { name: 'charmap', bundleId: 'charmap', pid: 42 },
      launched: true,
      delivery: 'foreground'
    })
    expect(callBridge).toHaveBeenCalledWith({ tool: 'launch_app', app: 'charmap', activate: false })
  })
})
