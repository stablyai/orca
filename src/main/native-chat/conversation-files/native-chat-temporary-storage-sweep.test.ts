import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { nativeChatScratchFolderName } from './native-chat-scratch-folder'
import { prepareChatTemporaryFolder } from './native-chat-temporary-storage'
import {
  sweepNativeChatTemporaryFolders,
  type NativeChatVisualsSweepDeps
} from './native-chat-visuals-sweep'

function deps(stateDirectory: string, held: readonly string[] | null): NativeChatVisualsSweepDeps {
  return {
    stateDirectory,
    listHeldSessionIds: () => held,
    logger: { warn: vi.fn(), error: vi.fn() }
  }
}

it("removes the temporary data of a chat that is gone and keeps a retained chat's", async () => {
  const state = mkdtempSync(join(tmpdir(), 'orca-temporary-sweep-'))
  try {
    const kept = await prepareChatTemporaryFolder(state, nativeChatScratchFolderName('chat-kept'))
    const gone = await prepareChatTemporaryFolder(state, nativeChatScratchFolderName('chat-gone'))
    writeFileSync(join(kept, 'build.bin'), 'in use')
    writeFileSync(join(gone, 'build.bin'), 'left behind')

    expect(await sweepNativeChatTemporaryFolders(deps(state, ['chat-kept']))).toEqual({
      removed: 1,
      failed: 0
    })
    expect(readFileSync(join(kept, 'build.bin'), 'utf8')).toBe('in use')
    expect(existsSync(gone)).toBe(false)

    const unknown = await prepareChatTemporaryFolder(state, nativeChatScratchFolderName('chat-x'))
    expect(await sweepNativeChatTemporaryFolders(deps(state, null))).toEqual({
      removed: 0,
      failed: 0
    })
    expect(existsSync(unknown)).toBe(true)
  } finally {
    rmSync(state, { recursive: true, force: true })
  }
})
