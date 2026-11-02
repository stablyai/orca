import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFsPromises from 'node:fs/promises'

const fsFaults = vi.hoisted(
  (): { operation: 'utimes' | 'copyFile' | 'unlink' | 'rename' | null } => ({ operation: null })
)
vi.mock('node:fs/promises', async (importOriginal) => {
  const fsp = await importOriginal<typeof NodeFsPromises>()
  function throwFilesystemFault(operation: typeof fsFaults.operation): void {
    if (fsFaults.operation === operation) {
      throw Object.assign(new Error('filesystem fault'), { code: 'EIO' })
    }
  }
  return {
    ...fsp,
    utimes: async (...args: Parameters<typeof fsp.utimes>) => {
      throwFilesystemFault('utimes')
      return fsp.utimes(...args)
    },
    copyFile: async (...args: Parameters<typeof fsp.copyFile>) => {
      throwFilesystemFault('copyFile')
      return fsp.copyFile(...args)
    },
    unlink: async (...args: Parameters<typeof fsp.unlink>) => {
      throwFilesystemFault('unlink')
      return fsp.unlink(...args)
    },
    rename: async (...args: Parameters<typeof fsp.rename>) => {
      throwFilesystemFault('rename')
      return fsp.rename(...args)
    }
  }
})
import type { StructuredAgentSessionLogger } from './agent-session-wire/structured-agent-session-logger'
import { nativeChatScratchFolderFor, nativeChatScratchRootFor } from './native-chat-scratch-folder'
import { migrateLegacyNativeChatVisualsFolders } from './native-chat-scratch-folder-migration'
import { readNativeChatVisualFile } from './native-chat-visual-file-read'

const scratch: string[] = []
afterEach(() => {
  fsFaults.operation = null
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function stateDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-visuals-migration-'))
  scratch.push(dir)
  return dir
}

function legacyRootOf(state: string): string {
  return join(state, 'native-chat-visuals')
}

function seed(folder: string, files: Record<string, string>): string {
  mkdirSync(folder, { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(folder, name), body)
  }
  return folder
}

/** A chat's folder as v1.4.227 wrote it, under the old root with the same hashed name. */
function legacyFor(state: string, sessionId: string, files: Record<string, string>): string {
  return seed(
    join(legacyRootOf(state), basename(nativeChatScratchFolderFor(state, sessionId))),
    files
  )
}

function currentFor(state: string, sessionId: string, files: Record<string, string>): string {
  return seed(nativeChatScratchFolderFor(state, sessionId), files)
}

function logger(): StructuredAgentSessionLogger & {
  warn: ReturnType<typeof vi.fn<StructuredAgentSessionLogger['warn']>>
} {
  return { warn: vi.fn<StructuredAgentSessionLogger['warn']>(), error: vi.fn() }
}

describe('moving pre-rename chat visuals folders', () => {
  it('moves each chat folder under the current root with a fresh window and removes the old root', async () => {
    const state = stateDirectory()
    const folder = legacyFor(state, 'chat-old', { 'chart.html': '<p>old chart</p>' })
    const then = new Date(Date.now() - 40 * 24 * 60 * 60_000)
    utimesSync(join(folder, 'chart.html'), then, then)
    utimesSync(folder, then, then)
    writeFileSync(join(legacyRootOf(state), 'notes.txt'), 'not ours')
    const before = Date.now() - 1_000

    await migrateLegacyNativeChatVisualsFolders(state, logger())

    const moved = nativeChatScratchFolderFor(state, 'chat-old')
    expect(readFileSync(join(moved, 'chart.html'), 'utf8')).toBe('<p>old chart</p>')
    // The move is the first time the 30-day rule applies to this chat: it starts counting now.
    expect(statSync(moved).mtimeMs).toBeGreaterThanOrEqual(before)
    // Only what this host minted moves; the old root stays while anything else is in it.
    expect(readdirSync(legacyRootOf(state))).toEqual(['notes.txt'])
    rmSync(join(legacyRootOf(state), 'notes.txt'))
    await migrateLegacyNativeChatVisualsFolders(state, logger())
    expect(existsSync(legacyRootOf(state))).toBe(false)
  })

  it('preserves saved filenames and keeps conflicting copies inside the chat folder', async () => {
    const state = stateDirectory()
    legacyFor(state, 'chat-both', {
      'chart.html': '<p>older</p>',
      'chart.previous.html': '<p>separate saved visual</p>'
    })
    const both = currentFor(state, 'chat-both', { 'chart.html': '<p>current</p>' })

    await migrateLegacyNativeChatVisualsFolders(state, logger())

    expect(await readNativeChatVisualFile(both, 'chart.html')).toMatchObject({
      ok: true,
      html: '<p>current</p>'
    })
    expect(await readNativeChatVisualFile(both, 'chart.previous.html')).toMatchObject({
      ok: true,
      html: '<p>separate saved visual</p>'
    })
    const recovery = readdirSync(both, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory()
    )
    expect(recovery).toHaveLength(1)
    expect(readFileSync(join(both, recovery[0].name, 'files', 'chart.html'), 'utf8')).toBe(
      '<p>older</p>'
    )
    expect(existsSync(legacyRootOf(state))).toBe(false)
  })

  it('preserves nested leftovers without replacing an existing recovery folder', async () => {
    const state = stateDirectory()
    const legacy = legacyFor(state, 'chat-both', { 'chart.html': '<p>older</p>' })
    mkdirSync(join(legacy, 'drafts'))
    writeFileSync(join(legacy, 'drafts', 'chart.html'), '<p>draft</p>')
    const both = currentFor(state, 'chat-both', { 'chart.html': '<p>current</p>' })
    const prior = join(both, '.legacy-visuals-prior')
    mkdirSync(prior)
    writeFileSync(join(prior, 'notes.txt'), 'already recovered')

    await migrateLegacyNativeChatVisualsFolders(state, logger())

    expect(readFileSync(join(prior, 'notes.txt'), 'utf8')).toBe('already recovered')
    const recovery = readdirSync(both, { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && entry.name !== basename(prior)
    )
    expect(recovery).toHaveLength(1)
    const files = join(both, recovery[0].name, 'files')
    expect(readFileSync(join(files, 'chart.html'), 'utf8')).toBe('<p>older</p>')
    expect(readFileSync(join(files, 'drafts', 'chart.html'), 'utf8')).toBe('<p>draft</p>')
    expect(existsSync(legacyRootOf(state))).toBe(false)
  })

  it.each(['copyFile', 'unlink', 'rename'] as const)(
    'keeps failed work retryable after a %s failure',
    async (operation) => {
      const state = stateDirectory()
      const legacy = legacyFor(state, 'chat-both', {
        'chart.html': '<p>older</p>',
        'other.html': '<p>saved visual</p>'
      })
      const both = currentFor(state, 'chat-both', { 'chart.html': '<p>current</p>' })
      fsFaults.operation = operation
      const log = logger()

      await migrateLegacyNativeChatVisualsFolders(state, log)

      expect(readFileSync(join(legacy, 'chart.html'), 'utf8')).toBe('<p>older</p>')
      expect(readFileSync(join(both, 'chart.html'), 'utf8')).toBe('<p>current</p>')
      expect(
        readdirSync(both, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      ).toEqual([])
      expect(log.warn).toHaveBeenCalled()

      fsFaults.operation = null
      await migrateLegacyNativeChatVisualsFolders(state, logger())

      expect(await readNativeChatVisualFile(both, 'other.html')).toMatchObject({
        ok: true,
        html: '<p>saved visual</p>'
      })
      expect(readFileSync(join(both, 'chart.html'), 'utf8')).toBe('<p>current</p>')
      const recovery = readdirSync(both, { withFileTypes: true }).filter(
        (entry) => entry.isDirectory() && existsSync(join(both, entry.name, 'files', 'chart.html'))
      )
      expect(recovery).toHaveLength(1)
      expect(readFileSync(join(both, recovery[0].name, 'files', 'chart.html'), 'utf8')).toBe(
        '<p>older</p>'
      )
      expect(existsSync(legacyRootOf(state))).toBe(false)
    }
  )

  it('moves nothing into a destination that is a symlink', async () => {
    const state = stateDirectory()
    const elsewhere = join(state, 'elsewhere')
    mkdirSync(elsewhere)
    legacyFor(state, 'chat-linked', { 'chart.html': '<p>chart</p>' })
    mkdirSync(nativeChatScratchRootFor(state))
    symlinkSync(elsewhere, nativeChatScratchFolderFor(state, 'chat-linked'))
    const linkedRoot = stateDirectory()
    legacyFor(linkedRoot, 'chat-any', { 'chart.html': '<p>chart</p>' })
    symlinkSync(elsewhere, nativeChatScratchRootFor(linkedRoot))

    const log = logger()
    await migrateLegacyNativeChatVisualsFolders(state, log)
    await migrateLegacyNativeChatVisualsFolders(linkedRoot, log)

    expect(readdirSync(elsewhere)).toEqual([])
    expect(
      existsSync(
        join(
          legacyRootOf(state),
          basename(nativeChatScratchFolderFor(state, 'chat-linked')),
          'chart.html'
        )
      )
    ).toBe(true)
    expect(
      existsSync(
        join(
          legacyRootOf(linkedRoot),
          basename(nativeChatScratchFolderFor(linkedRoot, 'chat-any')),
          'chart.html'
        )
      )
    ).toBe(true)
    expect(log.warn.mock.calls.map(([, meta]) => meta?.scope)).toEqual([
      'nativeChatVisuals.migration'
    ])
  })

  it('leaves a folder in the old root when its fresh window cannot be set', async () => {
    const state = stateDirectory()
    const folder = legacyFor(state, 'chat-old', { 'chart.html': '<p>old chart</p>' })
    fsFaults.operation = 'utimes'

    const log = logger()
    await migrateLegacyNativeChatVisualsFolders(state, log)

    // Still where the next install retries it, rather than moved with a time the sweep would act on.
    expect(readFileSync(join(folder, 'chart.html'), 'utf8')).toBe('<p>old chart</p>')
    expect(existsSync(nativeChatScratchFolderFor(state, 'chat-old'))).toBe(false)
    expect(log.warn.mock.calls.map(([, meta]) => meta?.scope)).toEqual([
      'nativeChatVisuals.migration'
    ])
  })

  it('does nothing when there is no old root', async () => {
    const state = stateDirectory()
    const log = logger()
    await migrateLegacyNativeChatVisualsFolders(state, log)
    expect(existsSync(nativeChatScratchRootFor(state))).toBe(false)
    expect(log.warn).not.toHaveBeenCalled()
  })
})
