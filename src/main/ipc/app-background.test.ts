import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
  app: { getPath: appGetPathMock },
  BrowserWindow: {
    fromWebContents: browserWindowFromWebContentsMock,
    getFocusedWindow: browserWindowGetFocusedWindowMock
  },
  dialog: { showOpenDialog: showOpenDialogMock },
  ipcMain: { handle: handleMock }
}))

vi.mock('../i18n/main-i18n', () => ({
  translateMain: (key: string, fallback: string) => `[${key}] ${fallback}`
}))

import { registerAppBackgroundHandlers, sweepAppBackgroundImages } from './app-background'
import { MAX_APP_BACKGROUND_IMAGE_BYTES } from '../../shared/app-background-settings'

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('png-body')])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const OLD_ID = '11111111-2222-4333-8444-555555555555.png'

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>

describe('registerAppBackgroundHandlers', () => {
  let tempDir: string
  let userDataDir: string
  let appearanceDir: string
  let stagingDir: string
  let settings: { appBackgroundImageId?: string | null }
  const handlers = new Map<string, Handler>()
  const store = {
    getSettings: vi.fn(() => settings),
    updateSettingsAndFlush: vi.fn(async (updates: typeof settings) => {
      settings = { ...settings, ...updates }
      return settings
    })
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'orca-app-background-test-'))
    userDataDir = join(tempDir, 'user-data')
    appearanceDir = join(userDataDir, 'appearance')
    stagingDir = join(appearanceDir, '.staging')
    settings = { appBackgroundImageId: null }
    handlers.clear()
    handleMock.mockReset().mockImplementation((channel: string, handler: Handler) => {
      handlers.set(channel, handler)
    })
    appGetPathMock.mockReset().mockReturnValue(userDataDir)
    browserWindowFromWebContentsMock.mockReset().mockReturnValue(null)
    browserWindowGetFocusedWindowMock.mockReset().mockReturnValue(null)
    showOpenDialogMock.mockReset()
    store.getSettings.mockClear()
    store.updateSettingsAndFlush.mockClear()
    registerAppBackgroundHandlers(store)
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  function handler(channel: string): Handler {
    const found = handlers.get(channel)
    if (!found) {
      throw new Error(`${channel} handler not registered`)
    }
    return found
  }

  async function pickFile(name: string, bytes: Buffer): Promise<unknown> {
    const src = join(tempDir, name)
    await writeFile(src, bytes)
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [src] })
    return handler('appBackground:pick')({ sender: {} })
  }

  async function pickStagingId(name: string, bytes: Buffer): Promise<string> {
    const result = await pickFile(name, bytes)
    if (
      typeof result !== 'object' ||
      result === null ||
      !('stagingId' in result) ||
      typeof result.stagingId !== 'string'
    ) {
      throw new Error(`expected a picked image, got ${JSON.stringify(result)}`)
    }
    return result.stagingId
  }

  async function readImage(args: { id: string; staging?: boolean }): Promise<Buffer> {
    const result = await handler('appBackground:read')({}, args)
    if (!(result instanceof ArrayBuffer)) {
      throw new Error(`expected image bytes, got ${String(result)}`)
    }
    return Buffer.from(result)
  }

  it('stages a valid image under a uuid id and serves it from staging', async () => {
    const stagingId = await pickStagingId('Photo.JPG', JPEG)

    expect(stagingId).toMatch(/^[0-9a-f-]{36}\.jpg$/)
    await expect(readFile(join(stagingDir, stagingId))).resolves.toEqual(JPEG)
    await expect(readImage({ id: stagingId, staging: true })).resolves.toEqual(JPEG)
    await expect(handler('appBackground:read')({}, { id: stagingId })).resolves.toBeNull()
  })

  it.each([
    ['a.png', PNG],
    ['a.jpeg', JPEG],
    ['a.gif', Buffer.from('GIF87a\x01\x00\x01\x00', 'latin1')],
    ['a.webp', Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1')]
  ])('accepts %s when its header matches', async (name, bytes) => {
    const stagingId = await pickStagingId(name, bytes)
    expect(stagingId.endsWith(name.slice(1))).toBe(true)
  })

  it('titles the file dialog with localized copy', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] })
    await handler('appBackground:pick')({ sender: {} })
    expect(showOpenDialogMock.mock.calls[0]?.[0]).toMatchObject({
      title: '[settings.appearance.background.pickDialogTitle] Choose background image'
    })
  })

  it('reports a canceled dialog without touching disk', async () => {
    showOpenDialogMock.mockResolvedValue({ canceled: true, filePaths: [] })
    await expect(handler('appBackground:pick')({ sender: {} })).resolves.toEqual({
      status: 'canceled'
    })
  })

  it('rejects files over the size limit', async () => {
    const big = Buffer.alloc(MAX_APP_BACKGROUND_IMAGE_BYTES + 1)
    PNG.copy(big)
    await expect(pickFile('big.png', big)).resolves.toEqual({
      status: 'rejected',
      reason: 'tooLarge'
    })
  })

  it('rejects files whose header does not match the extension', async () => {
    await expect(pickFile('fake.png', JPEG)).resolves.toEqual({
      status: 'rejected',
      reason: 'unsupportedType'
    })
    await expect(pickFile('notes.png', Buffer.from('plain text'))).resolves.toEqual({
      status: 'rejected',
      reason: 'unsupportedType'
    })
    await expect(pickFile('vector.svg', Buffer.from('<svg/>'))).resolves.toEqual({
      status: 'rejected',
      reason: 'unsupportedType'
    })
    await expect(readdir(stagingDir)).rejects.toThrow()
  })

  it('refuses path traversal and malformed read arguments', async () => {
    await mkdir(userDataDir, { recursive: true })
    await writeFile(join(userDataDir, 'secret.png'), PNG)
    const read = handler('appBackground:read')

    await expect(read({}, { id: '../secret.png' })).resolves.toBeNull()
    await expect(read({}, { id: '../../user-data/secret.png', staging: true })).resolves.toBeNull()
    await expect(read({}, { id: `${OLD_ID}/../../secret.png` })).resolves.toBeNull()
    await expect(read({}, { id: 42 })).rejects.toThrow('Invalid appBackground:read arguments')
    await expect(
      handler('appBackground:commit')({}, { stagingId: '../secret.png' })
    ).resolves.toEqual({ ok: false, reason: 'invalidId' })
    expect(store.updateSettingsAndFlush).not.toHaveBeenCalled()
  })

  it('commits by renaming out of staging and removes the previous image', async () => {
    await mkdir(appearanceDir, { recursive: true })
    await writeFile(join(appearanceDir, OLD_ID), PNG)
    await writeFile(join(appearanceDir, 'user-note.txt'), 'keep')
    settings = { appBackgroundImageId: OLD_ID }
    const stagingId = await pickStagingId('next.png', PNG)

    await expect(handler('appBackground:commit')({}, { stagingId })).resolves.toEqual({
      ok: true,
      imageId: stagingId
    })
    expect(store.updateSettingsAndFlush).toHaveBeenCalledWith(
      { appBackgroundImageId: stagingId },
      { notifyListeners: true }
    )
    expect((await readdir(appearanceDir)).sort()).toEqual(
      ['.staging', stagingId, 'user-note.txt'].sort()
    )
    expect(await readdir(stagingDir)).toEqual([])
    await expect(readImage({ id: stagingId })).resolves.toEqual(PNG)
  })

  it('commit(null) removes the background image and clears the setting', async () => {
    await mkdir(appearanceDir, { recursive: true })
    await writeFile(join(appearanceDir, OLD_ID), PNG)
    settings = { appBackgroundImageId: OLD_ID }

    await expect(handler('appBackground:commit')({}, { stagingId: null })).resolves.toEqual({
      ok: true,
      imageId: null
    })

    expect(settings.appBackgroundImageId).toBeNull()
    expect(await readdir(appearanceDir)).toEqual([])
  })

  it('reports a missing staged image without changing settings', async () => {
    settings = { appBackgroundImageId: OLD_ID }
    await expect(
      handler('appBackground:commit')({}, { stagingId: '99999999-2222-4333-8444-555555555555.png' })
    ).resolves.toEqual({ ok: false, reason: 'stagingMissing' })
    expect(settings.appBackgroundImageId).toBe(OLD_ID)
  })

  it('moves the image back to staging when saving the setting fails', async () => {
    await mkdir(appearanceDir, { recursive: true })
    await writeFile(join(appearanceDir, OLD_ID), PNG)
    settings = { appBackgroundImageId: OLD_ID }
    const stagingId = await pickStagingId('next.png', PNG)
    store.updateSettingsAndFlush.mockRejectedValueOnce(new Error('disk full'))

    await expect(handler('appBackground:commit')({}, { stagingId })).resolves.toEqual({
      ok: false,
      reason: 'saveFailed'
    })
    expect(settings.appBackgroundImageId).toBe(OLD_ID)
    expect((await readdir(appearanceDir)).sort()).toEqual(['.staging', OLD_ID].sort())
    expect(await readdir(stagingDir)).toEqual([stagingId])

    // The restored staging file must survive the sweep and still be committable.
    await sweepAppBackgroundImages(store)
    await expect(handler('appBackground:commit')({}, { stagingId })).resolves.toEqual({
      ok: true,
      imageId: stagingId
    })
  })

  it('discards a staged image', async () => {
    const stagingId = await pickStagingId('discard.webp', Buffer.from('RIFF\0\0\0\0WEBPVP8 '))

    await handler('appBackground:discard')({}, stagingId)

    expect(await readdir(stagingDir)).toEqual([])
    await expect(handler('appBackground:discard')({}, '../../secret')).resolves.toBeUndefined()
  })

  it('sweeps stale staged images but keeps this session’s picks and foreign files', async () => {
    const stale = '22222222-2222-4333-8444-555555555555.gif'
    await mkdir(stagingDir, { recursive: true })
    await writeFile(join(stagingDir, stale), 'GIF89a')
    await writeFile(join(stagingDir, 'readme.txt'), 'not ours')
    const fresh = await pickStagingId('fresh.png', PNG)

    await sweepAppBackgroundImages(store)

    expect((await readdir(stagingDir)).sort()).toEqual([fresh, 'readme.txt'].sort())
  })

  it('sweeps committed images the settings no longer reference', async () => {
    const orphan = '33333333-2222-4333-8444-555555555555.jpg'
    await mkdir(appearanceDir, { recursive: true })
    await writeFile(join(appearanceDir, OLD_ID), PNG)
    await writeFile(join(appearanceDir, orphan), JPEG)
    await writeFile(join(appearanceDir, 'user-note.txt'), 'keep')
    await mkdir(join(appearanceDir, '44444444-2222-4333-8444-555555555555.png'))
    settings = { appBackgroundImageId: OLD_ID }

    await sweepAppBackgroundImages(store)

    expect((await readdir(appearanceDir)).sort()).toEqual(
      [OLD_ID, 'user-note.txt', '44444444-2222-4333-8444-555555555555.png'].sort()
    )
  })

  it('does not sweep an image whose commit is still saving the setting', async () => {
    const stagingId = await pickStagingId('racing.png', PNG)
    let finishSave: () => void = () => {}
    store.updateSettingsAndFlush.mockImplementationOnce(async (updates: typeof settings) => {
      await new Promise<void>((resolve) => {
        finishSave = resolve
      })
      settings = { ...settings, ...updates }
      return settings
    })

    const commit = handler('appBackground:commit')({}, { stagingId })
    await vi.waitFor(() => expect(store.updateSettingsAndFlush).toHaveBeenCalled())
    const sweep = sweepAppBackgroundImages(store)
    // Give an unqueued sweep time to run while settings still name no image.
    await Promise.race([sweep, new Promise((resolve) => setTimeout(resolve, 50))])
    finishSave()
    await expect(commit).resolves.toEqual({ ok: true, imageId: stagingId })
    await sweep

    await expect(readImage({ id: stagingId })).resolves.toEqual(PNG)
  })

  it('treats a missing staging directory as nothing to sweep', async () => {
    await expect(sweepAppBackgroundImages(store)).resolves.toBeUndefined()
  })
})
