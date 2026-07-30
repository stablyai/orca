import { expect, vi } from 'vitest'

const { executeSupervisedDesktopProviderMock } = vi.hoisted(() => ({
  executeSupervisedDesktopProviderMock: vi.fn()
}))

vi.mock('./computer-provider-supervisor-client', () => ({
  executeSupervisedDesktopProvider: executeSupervisedDesktopProviderMock
}))

export async function createDesktopScriptProviderClient(
  _platform: 'linux' | 'windows',
  _executablePath: string
) {
  const { DesktopScriptProviderClient } = await import('./desktop-script-provider-client')
  return new DesktopScriptProviderClient()
}

export function resetDesktopScriptProviderTestHarness(): void {
  vi.useRealTimers()
  executeSupervisedDesktopProviderMock.mockReset()
}

export function expectDesktopProviderSubprocessStartCount(count: number): void {
  expect(executeSupervisedDesktopProviderMock).toHaveBeenCalledTimes(count)
}

export function mockBridgeExecutionError(message: string): void {
  executeSupervisedDesktopProviderMock.mockResolvedValueOnce({
    stdout: '',
    stderr: message,
    error: { message, killed: false }
  })
}

export function mockBridgeResponse(
  response: unknown,
  inspectOperation?: (operation: Record<string, unknown>) => void
): void {
  executeSupervisedDesktopProviderMock.mockImplementationOnce(
    async (operation: Record<string, unknown>) => {
      inspectOperation?.(operation)
      return {
        stdout: JSON.stringify(response),
        stderr: '',
        error: null
      }
    }
  )
}

export function sampleBridgeSnapshot(name: string, value: string) {
  return {
    app: { name, bundleIdentifier: name, pid: 100 },
    snapshotId: 'snap-test',
    windowTitle: name,
    windowId: 99,
    windowBounds: { x: 10, y: 20, width: 300, height: 200 },
    screenshotPngBase64: 'iVBORw0KGgo=',
    coordinateSpace: 'window',
    truncation: { truncated: false, maxNodes: 1200, maxDepth: 64, maxDepthReached: false },
    treeLines: [`0 text entry area, Value: ${value}`],
    focusedSummary: 'text entry area',
    elements: [
      {
        index: 0,
        runtimeId: [0, 0],
        name: 'Body',
        controlType: 'text',
        localizedControlType: 'text entry area',
        value,
        frame: { x: 1, y: 2, width: 100, height: 20 },
        actions: ['SetValue']
      }
    ]
  }
}

export function sampleCapabilities(actions: Partial<Record<string, boolean>> = {}) {
  return {
    platform: 'linux',
    provider: 'orca-computer-use-linux',
    providerVersion: '1.0.0',
    protocolVersion: 1,
    supports: {
      apps: { list: true, bundleIds: false, pids: true },
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
        performAction: true,
        ...actions
      },
      surfaces: { menus: false, dialogs: false, dock: false, menubar: false }
    }
  }
}

export function publicSnapshotKeys(snapshot: unknown): string[] {
  return Object.keys(snapshot as Record<string, unknown>).sort()
}
