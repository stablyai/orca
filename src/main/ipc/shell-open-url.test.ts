import { beforeEach, expect, it, vi } from 'vitest'

const { handleMock, openExternalMock } = vi.hoisted(() => ({
  handleMock: vi.fn<(channel: string, handler: (event: unknown, url: string) => unknown) => void>(),
  openExternalMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock },
  shell: { openExternal: openExternalMock, openPath: vi.fn(), showItemInFolder: vi.fn() },
  dialog: { showOpenDialog: vi.fn() }
}))

import { registerShellHandlers } from './shell'

beforeEach(() => {
  handleMock.mockClear()
  openExternalMock.mockClear()
})

it.each([
  ['https://example.com', 'https://example.com/'],
  ['vscode://file/D:/src/project/Example.cs:120', 'vscode://file/D:/src/project/Example.cs:120'],
  [
    'vscode-insiders://file/D:/src/project/Example.cs:120',
    'vscode-insiders://file/D:/src/project/Example.cs:120'
  ],
  ['file:///tmp/example.md', null],
  ['vscode://some-extension-id/do-something', null],
  ['vscode-insiders://some-extension-id/do-something', null],
  ['vscode://user@file/D:/src/project/Example.cs:120', null],
  ['vscode://user:pass@file/D:/src/project/Example.cs:120', null],
  ['vscode://file:8080/D:/src/project/Example.cs:120', null],
  ['vscode://file/tmp/example.ts?continueOn=1', null],
  ['vscode://file/tmp/example.ts#L1', null]
])('routes %s only when it is an allowed external URL', async (url, expected) => {
  registerShellHandlers({ getSshTarget: () => undefined })
  const handler = handleMock.mock.calls.find(([channel]) => channel === 'shell:openUrl')?.[1]
  expect(handler).toBeDefined()
  await handler?.({}, url)
  if (expected === null) {
    expect(openExternalMock).not.toHaveBeenCalled()
  } else {
    expect(openExternalMock).toHaveBeenCalledExactlyOnceWith(expected)
  }
})
