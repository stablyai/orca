import { describe, expect, it, vi } from 'vitest'
import type { IFilesystemProvider } from '../providers/types'
import { enableRemoteKiroTerminalTitle } from './kiro-remote-terminal-title-setting'

function fakeProvider(existing: string | null) {
  const writeFile = vi.fn(async (_filePath: string, _content: string) => {})
  const createDir = vi.fn(async (_dirPath: string) => {})
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the function under test reads only stat/readFile/createDir/writeFile.
  const provider = {
    stat: async () => {
      if (existing === null) {
        throw new Error('ENOENT')
      }
      return {}
    },
    readFile: async () => ({ content: existing ?? '', isBinary: false }),
    createDir,
    writeFile
  } as unknown as IFilesystemProvider
  return { provider, writeFile, createDir }
}

describe('enableRemoteKiroTerminalTitle', () => {
  it('writes the setting on a host that has no Kiro settings file yet', async () => {
    const { provider, writeFile, createDir } = fakeProvider(null)
    expect(await enableRemoteKiroTerminalTitle(provider, '/home/dev')).toBe('enabled')
    expect(createDir).toHaveBeenCalledWith('/home/dev/.kiro/settings')
    expect(JSON.parse(writeFile.mock.calls[0][1])).toEqual({
      'chat.terminalTitle': true
    })
  })

  it('preserves every other key the host already has', async () => {
    const { provider, writeFile } = fakeProvider(JSON.stringify({ 'autocomplete.theme': 'dark' }))
    expect(await enableRemoteKiroTerminalTitle(provider, '/home/dev')).toBe('enabled')
    expect(JSON.parse(writeFile.mock.calls[0][1])).toEqual({
      'autocomplete.theme': 'dark',
      'chat.terminalTitle': true
    })
  })

  it('does not re-enable a value the user turned off on the host', async () => {
    const { provider, writeFile } = fakeProvider(JSON.stringify({ 'chat.terminalTitle': false }))
    expect(await enableRemoteKiroTerminalTitle(provider, '/home/dev')).toBe('already-set')
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('leaves a remote file it cannot parse alone', async () => {
    const { provider, writeFile } = fakeProvider('{ not json')
    expect(await enableRemoteKiroTerminalTitle(provider, '/home/dev')).toBe('failed')
    expect(writeFile).not.toHaveBeenCalled()
  })
})
