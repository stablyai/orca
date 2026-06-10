import { expect, vi } from 'vitest'

const { execFileMock, operationFiles, mkdtempMock, rmMock, writeFileMock } = vi.hoisted(() => {
  const files = new Map<string, string>()
  return {
    execFileMock: vi.fn(),
    operationFiles: files,
    mkdtempMock: vi.fn(async (prefix: string) => `${prefix}${files.size}`),
    rmMock: vi.fn(async () => undefined),
    writeFileMock: vi.fn(async (filePath: string, data: string | Buffer) => {
      files.set(filePath, Buffer.isBuffer(data) ? data.toString('utf8') : data)
    })
  }
})

vi.mock('child_process', () => ({
  execFile: execFileMock
}))

vi.mock('fs/promises', () => ({
  mkdtemp: mkdtempMock,
  rm: rmMock,
  writeFile: writeFileMock
}))

export async function createDesktopScriptProviderClient(
  platform: 'linux' | 'windows',
  executablePath: string
) {
  const { DesktopScriptProviderClient } = await import('./desktop-script-provider-client')
  return new DesktopScriptProviderClient(platform, executablePath)
}

export function resetDesktopScriptProviderTestHarness(): void {
  vi.useRealTimers()
  execFileMock.mockReset()
  operationFiles.clear()
  mkdtempMock.mockClear()
  rmMock.mockClear()
  writeFileMock.mockClear()
}

export function mockDesktopProviderSubprocessThatIgnoresTimeout({
  kill,
  once
}: {
  kill: (signal: string) => void
  once: () => void
}): void {
  execFileMock.mockImplementationOnce(() => ({ kill, once }) as never)
}

export function expectDesktopProviderSubprocessStarted(): void {
  expect(execFileMock).toHaveBeenCalled()
}

export function expectDesktopProviderSubprocessStartCount(count: number): void {
  expect(execFileMock).toHaveBeenCalledTimes(count)
}

export function mockBridgeResponse(
  response: unknown,
  inspectOperation?: (operation: Record<string, unknown>) => void
): void {
  execFileMock.mockImplementationOnce((_command, _args, _options, callback) => {
    const operationPath = _args?.at(-1)
    if (inspectOperation && typeof operationPath === 'string') {
      const operation = operationFiles.get(operationPath)
      if (!operation) {
        throw new Error(`Missing mocked operation file: ${operationPath}`)
      }
      inspectOperation(JSON.parse(operation) as Record<string, unknown>)
    }
    const done = callback as (error: Error | null, stdout: string, stderr: string) => void
    done(null, JSON.stringify(response), '')
    return null as never
  })
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

export function sampleListWindowsCapabilities() {
  return sampleCapabilities({
    hotkey: false,
    pasteText: false
  })
}

export function publicSnapshotKeys(snapshot: unknown): string[] {
  return Object.keys(snapshot as Record<string, unknown>).sort()
}
