import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalize, resolve } from 'node:path'

const { execFileMock, handleMock, openExternalMock, resolveCliCommandMock, statMock } = vi.hoisted(
  () => ({
    execFileMock: vi.fn(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        queueMicrotask(() => callback(null, '', ''))
        return {}
      }
    ),
    handleMock: vi.fn(),
    openExternalMock: vi.fn(),
    resolveCliCommandMock: vi.fn(),
    statMock: vi.fn()
  })
)

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  },
  shell: {
    openExternal: openExternalMock
  }
}))

vi.mock('node:fs/promises', () => ({
  stat: statMock
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock
}))

vi.mock('../codex-cli/command', () => ({
  resolveCliCommand: resolveCliCommandMock
}))

import { registerExternalEditorFileLinkHandler } from './external-editor-file-links'

function getHandler(
  store?: Parameters<typeof registerExternalEditorFileLinkHandler>[0]
): (event: unknown, args: unknown) => Promise<boolean> {
  registerExternalEditorFileLinkHandler(store)
  const call = handleMock.mock.calls.find((c: unknown[]) => c[0] === 'shell:openExternalEditor')
  if (!call) {
    throw new Error('shell:openExternalEditor handler not registered')
  }
  return call[1] as (event: unknown, args: unknown) => Promise<boolean>
}

function createStore(
  settings: Partial<{
    fileLinkOpenTarget: 'orca' | 'external-editor'
    externalEditor: {
      kind: 'none' | 'vscode' | 'vscode-insiders' | 'cursor' | 'jetbrains-idea' | 'custom'
      strategy: 'cli' | 'url'
      command?: string
      argsTemplate?: string[]
      urlTemplate?: string
    }
  }> = {}
): Parameters<typeof registerExternalEditorFileLinkHandler>[0] {
  return {
    getSettings: () =>
      ({
        fileLinkOpenTarget: 'external-editor',
        externalEditor: { kind: 'vscode', strategy: 'cli' },
        ...settings
      }) as never
  } as unknown as Parameters<typeof registerExternalEditorFileLinkHandler>[0]
}

describe('registerExternalEditorFileLinkHandler', () => {
  beforeEach(() => {
    handleMock.mockReset()
    execFileMock.mockClear()
    openExternalMock.mockReset()
    resolveCliCommandMock.mockReset()
    statMock.mockReset()
    openExternalMock.mockResolvedValue(undefined)
    resolveCliCommandMock.mockReturnValue('editor-cli')
  })

  it('opens configured CLI editors with execFile and separate argv entries', async () => {
    statMock.mockResolvedValueOnce({ isFile: () => true })
    const filePath = resolve('workspace/a file; rm -rf nope.ts')
    const handler = getHandler(createStore())

    await expect(handler({}, { filePath, line: 3, column: 4 })).resolves.toBe(true)

    expect(resolveCliCommandMock).toHaveBeenCalledWith('code')
    expect(execFileMock).toHaveBeenCalledWith(
      'editor-cli',
      ['-g', `${normalize(filePath)}:3:4`],
      { windowsHide: true, timeout: 10_000 },
      expect.any(Function)
    )
    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('ignores renderer-supplied launch targets and uses persisted settings', async () => {
    statMock.mockResolvedValueOnce({ isFile: () => true })
    const filePath = resolve('workspace/main.ts')
    const handler = getHandler(createStore())

    await expect(
      handler({}, { filePath, line: 1, column: 1, kind: 'url', url: 'cursor://file/other' })
    ).resolves.toBe(true)

    expect(execFileMock).toHaveBeenCalledWith(
      'editor-cli',
      ['-g', `${normalize(filePath)}:1:1`],
      { windowsHide: true, timeout: 10_000 },
      expect.any(Function)
    )
    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('rejects directories and missing local files', async () => {
    statMock.mockResolvedValueOnce({ isFile: () => false })
    const handler = getHandler(createStore())

    await expect(handler({}, { filePath: resolve('workspace') })).resolves.toBe(false)

    expect(execFileMock).not.toHaveBeenCalled()
    expect(openExternalMock).not.toHaveBeenCalled()
  })

  it('opens allowlisted editor URL schemes', async () => {
    statMock.mockResolvedValueOnce({ isFile: () => true })
    const filePath = resolve('workspace/main.ts')
    const handler = getHandler(createStore({ externalEditor: { kind: 'vscode', strategy: 'url' } }))

    await expect(handler({}, { filePath, line: 9, column: 2 })).resolves.toBe(true)

    expect(openExternalMock).toHaveBeenCalledWith(expect.stringMatching(/^vscode:\/\/file\//))
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('rejects custom URL templates with unapproved schemes', async () => {
    statMock.mockResolvedValueOnce({ isFile: () => true })
    const handler = getHandler(
      createStore({
        externalEditor: {
          kind: 'custom',
          strategy: 'url',
          urlTemplate: 'https://example.com/{pathEncoded}'
        }
      })
    )

    await expect(handler({}, { filePath: resolve('workspace/main.ts') })).resolves.toBe(false)

    expect(openExternalMock).not.toHaveBeenCalled()
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('returns false when the configured editor launch fails so Orca can fall back', async () => {
    statMock.mockResolvedValueOnce({ isFile: () => true })
    execFileMock.mockImplementationOnce(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        queueMicrotask(() => callback(new Error('missing editor'), '', ''))
        return {}
      }
    )
    const handler = getHandler(createStore())

    await expect(handler({}, { filePath: resolve('workspace/main.ts') })).resolves.toBe(false)
  })
})
