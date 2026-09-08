import { afterEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_WEB_NATIVE_CHAT_FILE_METHODS } from './mobile-web-native-chat-files'
import { nativeChatPageFixture } from './mobile-web-native-chat-test-fixture'

const method = (name: string) =>
  MOBILE_WEB_NATIVE_CHAT_FILE_METHODS.find(
    (entry) => entry.name === `mobileWeb.nativeChat.${name}`
  )!
function fixture() {
  const f = nativeChatPageFixture()
  const searchMobileFilePaths = vi.fn().mockResolvedValue({
    worktree: 'host-workspace',
    rootPath: '/private/repo',
    files: [{ relativePath: 'src/main.ts' }],
    future: { rank: 1 }
  })
  const resolveTerminalPath = vi.fn().mockResolvedValue({
    worktree: 'host-workspace',
    absolutePath: '/private/repo/src/main.ts',
    relativePath: 'src/main.ts',
    exists: true,
    isDirectory: false
  })
  const openMobileFile = vi.fn().mockResolvedValue({ worktree: 'host-workspace', opened: true })
  Object.assign(f.context.runtime, { searchMobileFilePaths, resolveTerminalPath, openMobileFile })
  return {
    ...f,
    searchMobileFilePaths,
    resolveTerminalPath,
    openMobileFile,
    params: { ...f.scope, timeoutMs: 15_000 }
  }
}
afterEach(() => vi.useRealTimers())
describe('host-owned native chat file actions', () => {
  it('reuses page-safe search while retaining future results and authoritative workspace', async () => {
    const f = fixture()
    expect(
      await method('fileSearch').handler(
        { ...f.params, search: { worktree: 'forged', query: 'src', limit: 16 } },
        f.context
      )
    ).toEqual({ files: [{ relativePath: 'src/main.ts' }], future: { rank: 1 } })
    expect(f.searchMobileFilePaths).toHaveBeenCalledWith('id:host-workspace', 'src', 16)
  })
  it('resolves and opens through existing runtime handlers without returning private paths or handles', async () => {
    const f = fixture()
    expect(
      await method('openFile').handler({ ...f.params, pathText: 'src/main.ts' }, f.context)
    ).toEqual({ opened: true })
    expect(f.resolveTerminalPath).toHaveBeenCalledWith(
      'id:host-workspace',
      'src/main.ts',
      null,
      'authenticated-device-token',
      'host-terminal',
      false,
      null
    )
    expect(f.openMobileFile).toHaveBeenCalledWith('id:host-workspace', 'src/main.ts')
  })
  it.each([
    { exists: false },
    { exists: true, isDirectory: true },
    { exists: true, relativePath: '../private.txt' },
    {
      exists: true,
      relativePath: 'safe.txt',
      openTarget: { kind: 'absolute-file', absolutePath: '/private/a', grantId: 'private-grant' }
    }
  ])('does not open an invalid or external target: %j', async (resolved) => {
    const f = fixture()
    f.resolveTerminalPath.mockResolvedValueOnce(resolved)
    expect(await method('openFile').handler({ ...f.params, pathText: 'x' }, f.context)).toEqual({
      opened: false
    })
    expect(f.openMobileFile).not.toHaveBeenCalled()
  })
  it('refuses to resolve a path against a transcript the host no longer reports', async () => {
    const f = fixture()
    f.listMobileSessionTabs.mockResolvedValue({ worktree: 'host-workspace', tabs: [] })
    await expect(
      method('openFile').handler({ ...f.params, pathText: 'x' }, f.context)
    ).rejects.toThrow('selector_not_found')
    expect(f.resolveTerminalPath).not.toHaveBeenCalled()
    expect(f.openMobileFile).not.toHaveBeenCalled()
  })
  it('does not dispatch after a delayed lookup exhausts the deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const f = fixture()
    f.resolveTerminalPath.mockImplementationOnce(async () => {
      vi.setSystemTime(20_000)
      return { exists: true, relativePath: 'src/main.ts' }
    })
    await expect(
      method('openFile').handler({ ...f.params, pathText: 'x' }, f.context)
    ).rejects.toThrow('runtime_unavailable')
    expect(f.openMobileFile).not.toHaveBeenCalled()
  })
  it('preserves SSH failures and never retries a failed open acknowledgement', async () => {
    const f = fixture()
    f.searchMobileFilePaths.mockRejectedValueOnce(new Error('SSH provider unavailable'))
    await expect(
      method('fileSearch').handler({ ...f.params, search: {} }, f.context)
    ).rejects.toThrow('SSH provider unavailable')
    f.openMobileFile.mockRejectedValueOnce(new Error('lost acknowledgement'))
    await expect(
      method('openFile').handler({ ...f.params, pathText: 'x' }, f.context)
    ).rejects.toThrow('lost acknowledgement')
    expect(f.openMobileFile).toHaveBeenCalledOnce()
  })
  it('resolves the transcript binding once per file search', async () => {
    const f = fixture()
    await method('fileSearch').handler({ ...f.params, search: { query: 'src' } }, f.context)
    expect(f.listMobileSessionTabs).toHaveBeenCalledOnce()
  })
})
