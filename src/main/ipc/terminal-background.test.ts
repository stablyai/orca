import { mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appGetPathMock,
  browserWindowFromWebContentsMock,
  browserWindowGetFocusedWindowMock,
  handleMock,
  showOpenDialogMock
} = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
  browserWindowFromWebContentsMock: vi.fn(),
  browserWindowGetFocusedWindowMock: vi.fn(),
  handleMock: vi.fn(),
  showOpenDialogMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: appGetPathMock
  },
  BrowserWindow: {
    fromWebContents: browserWindowFromWebContentsMock,
    getFocusedWindow: browserWindowGetFocusedWindowMock
  },
  dialog: {
    showOpenDialog: showOpenDialogMock
  },
  ipcMain: {
    handle: handleMock
  }
}))

import {
  pruneOrphanTerminalBackgrounds,
  registerTerminalBackgroundHandlers
} from './terminal-background'
import type { TerminalBackgroundImage } from '../../shared/terminal-background-image'

const SEEDED_ID = '01234567-89ab-4cde-8f01-23456789abcd'
const OTHER_ID = 'fedcba98-7654-4321-8fed-cba987654321'

type StoreSettings = { terminalBackgroundImage?: { id?: string; fileName?: string } | null }

describe('registerTerminalBackgroundHandlers', () => {
  let tempDir: string
  let userDataDir: string
  let storeSettings: StoreSettings
  const store = { getSettings: (): StoreSettings => storeSettings }
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'orca-terminal-background-test-'))
    userDataDir = join(tempDir, 'user-data')
    storeSettings = {}
    handlers.clear()
    appGetPathMock.mockReset()
    browserWindowFromWebContentsMock.mockReset()
    browserWindowGetFocusedWindowMock.mockReset()
    handleMock.mockReset()
    showOpenDialogMock.mockReset()

    appGetPathMock.mockReturnValue(userDataDir)
    browserWindowFromWebContentsMock.mockReturnValue(null)
    browserWindowGetFocusedWindowMock.mockReturnValue(null)
    handleMock.mockImplementation((channel, handler) => {
      handlers.set(channel, handler)
    })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  function getHandler(channel: string): (event: unknown, ...args: unknown[]) => Promise<unknown> {
    registerTerminalBackgroundHandlers(store)
    const handler = handlers.get(channel)
    if (!handler) {
      throw new Error(`${channel} handler not registered`)
    }
    return handler
  }

  function backgroundsDir(): string {
    return join(userDataDir, 'terminal-backgrounds')
  }

  async function seedStoredFile(fileName: string, bytes: Buffer): Promise<string> {
    await mkdir(backgroundsDir(), { recursive: true })
    const filePath = join(backgroundsDir(), fileName)
    await writeFile(filePath, bytes)
    return filePath
  }

  it('registers the pick, read, and delete channels', () => {
    registerTerminalBackgroundHandlers(store)
    const channels = handleMock.mock.calls.map((call) => call[0] as string)
    expect(channels).toContain('terminalBackground:pick')
    expect(channels).toContain('terminalBackground:read')
    expect(channels).toContain('terminalBackground:delete')
  })

  it('returns null when the pick dialog is canceled', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] })
    await expect(getHandler('terminalBackground:pick')({ sender: {} })).resolves.toBeNull()
  })

  it('copies the picked image into userData under a fresh UUID name', async () => {
    const bytes = Buffer.from('png bytes')
    const src = join(tempDir, 'Naruto Wallpaper.png')
    await writeFile(src, bytes)
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [src] })

    const result = (await getHandler('terminalBackground:pick')({
      sender: {}
    })) as TerminalBackgroundImage

    expect(result.fileName).toBe(`${result.id}.png`)
    expect(result.mimeType).toBe('image/png')
    expect(result.label).toBe('Naruto Wallpaper')
    await expect(readFile(join(backgroundsDir(), result.fileName))).resolves.toEqual(bytes)
  })

  it('rejects unsupported file types on pick', async () => {
    const src = join(tempDir, 'not-an-image.txt')
    await writeFile(src, 'text')
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [src] })

    await expect(getHandler('terminalBackground:pick')({ sender: {} })).rejects.toThrow(
      'Unsupported file'
    )
  })

  it('rejects a picked path that is not a file', async () => {
    // Why: the extension gate passes for a directory named like an image, so
    // isFile() is the only guard between a directory and copyFile.
    const src = join(tempDir, 'looks-like-an-image.png')
    await mkdir(src, { recursive: true })
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [src] })

    await expect(getHandler('terminalBackground:pick')({ sender: {} })).rejects.toThrow(
      'Selected path is not a file'
    )
  })

  it('rejects a picked image above the size cap', async () => {
    const src = join(tempDir, 'too-big.png')
    await writeFile(src, Buffer.alloc(0))
    // Why: extend sparsely rather than writing 64 MB of real bytes.
    await truncate(src, 64 * 1024 * 1024 + 1)
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [src] })

    await expect(getHandler('terminalBackground:pick')({ sender: {} })).rejects.toThrow(
      'File is too large'
    )
  })

  it('reads stored image bytes back as an ArrayBuffer', async () => {
    const bytes = Buffer.from('stored image')
    await seedStoredFile(`${SEEDED_ID}.png`, bytes)

    const result = (await getHandler('terminalBackground:read')(
      {},
      SEEDED_ID,
      `${SEEDED_ID}.png`
    )) as ArrayBuffer | null

    expect(result).not.toBeNull()
    expect(Buffer.from(result as ArrayBuffer)).toEqual(bytes)
  })

  it('refuses to read a non-image file even when it exists under the id prefix', async () => {
    // A file named `<id>.json` sits in the dir but is not an allowlisted image.
    const filePath = await seedStoredFile(`${SEEDED_ID}.json`, Buffer.from('secret config'))

    const result = await getHandler('terminalBackground:read')({}, SEEDED_ID, `${SEEDED_ID}.json`)

    expect(result).toBeNull()
    // The extension gate rejects it before any fs access — file is untouched.
    await expect(stat(filePath)).resolves.toBeDefined()
  })

  it('refuses read requests that do not pass the id and fileName gates', async () => {
    await seedStoredFile(`${SEEDED_ID}.png`, Buffer.from('stored image'))
    const read = getHandler('terminalBackground:read')

    await expect(read({}, '../secret.txt', 'secret.txt')).resolves.toBeNull()
    await expect(read({}, SEEDED_ID, 'secret.png')).resolves.toBeNull()
    await expect(read({}, SEEDED_ID, `../${SEEDED_ID}.png`)).resolves.toBeNull()
    await expect(read({}, OTHER_ID, `${SEEDED_ID}.png`)).resolves.toBeNull()
    await expect(read({}, 42 as never, `${SEEDED_ID}.png`)).rejects.toThrow(
      'Invalid terminalBackground:read arguments'
    )
  })

  it('deletes a stored file that is not the active background', async () => {
    const filePath = await seedStoredFile(`${SEEDED_ID}.png`, Buffer.from('stored image'))

    await getHandler('terminalBackground:delete')({}, SEEDED_ID, `${SEEDED_ID}.png`)

    await expect(stat(filePath)).rejects.toThrow()
  })

  it('refuses to delete the file that is still the active background', async () => {
    storeSettings = { terminalBackgroundImage: { id: SEEDED_ID, fileName: `${SEEDED_ID}.png` } }
    const filePath = await seedStoredFile(`${SEEDED_ID}.png`, Buffer.from('stored image'))

    await getHandler('terminalBackground:delete')({}, SEEDED_ID, `${SEEDED_ID}.png`)

    await expect(stat(filePath)).resolves.toBeDefined()
  })

  it('ignores traversal attempts on delete', async () => {
    const secret = join(userDataDir, 'secret.txt')
    await mkdir(userDataDir, { recursive: true })
    await writeFile(secret, 'secret')

    await getHandler('terminalBackground:delete')({}, SEEDED_ID, '../secret.txt')

    await expect(stat(secret)).resolves.toBeDefined()
  })

  it('prunes orphaned files but keeps the active background', async () => {
    storeSettings = { terminalBackgroundImage: { id: SEEDED_ID, fileName: `${SEEDED_ID}.png` } }
    const kept = await seedStoredFile(`${SEEDED_ID}.png`, Buffer.from('active'))
    const orphan = await seedStoredFile(`${OTHER_ID}.png`, Buffer.from('orphan'))

    await pruneOrphanTerminalBackgrounds(store)

    await expect(stat(kept)).resolves.toBeDefined()
    await expect(stat(orphan)).rejects.toThrow()
  })

  it('prune is a no-op when the backgrounds dir does not exist', async () => {
    await expect(pruneOrphanTerminalBackgrounds(store)).resolves.toBeUndefined()
  })
})
