import { existsSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SPEECH_MODEL_CATALOG } from './model-catalog'
import { ModelManager } from './model-manager'
import { openElectronSpeechDownloadRequest } from '../host/electron-speech-services'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

const { appGetPathMock, netRequestMock } = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
  netRequestMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: appGetPathMock
  },
  net: {
    request: netRequestMock
  }
}))

// Desktop app environment supplies ModelManager's userData.
beforeEach(() => installFakeAppEnvironment({ getPath: (name) => appGetPathMock(name) }))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const originalProgramData = process.env.PROGRAMDATA

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

function restoreEnvironment(): void {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  if (originalProgramData === undefined) {
    delete process.env.PROGRAMDATA
  } else {
    process.env.PROGRAMDATA = originalProgramData
  }
}

describe('ModelManager Windows model path handling', () => {
  beforeEach(() => {
    appGetPathMock.mockReset()
    netRequestMock.mockReset()
    appGetPathMock.mockImplementation(() => join(tmpdir(), 'orca-speech-models-test'))
  })

  afterEach(() => {
    restoreEnvironment()
  })

  it('migrates existing ready model files from a non-ASCII Windows default cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
    try {
      setPlatform('win32')
      const programDataDir = join(dir, 'ProgramData')
      const userDataDir = join(dir, '用户', 'Orca')
      process.env.PROGRAMDATA = programDataDir
      appGetPathMock.mockImplementation((name: string) =>
        name === 'userData' ? userDataDir : join(dir, name)
      )
      const manifest = SPEECH_MODEL_CATALOG.find(
        (model) => model.id === 'zipformer-streaming-zh-14m'
      )
      expect(manifest?.files).toBeDefined()
      const legacyModelDir = join(userDataDir, 'speech-models', manifest!.id)
      for (const file of manifest!.downloadFiles ?? []) {
        const filePath = join(legacyModelDir, file.name)
        mkdirSync(dirname(filePath), { recursive: true })
        writeFileSync(filePath, '')
        truncateSync(filePath, file.sizeBytes)
      }

      const manager = new ModelManager(undefined, openElectronSpeechDownloadRequest)
      const migratedModelDir = manager.getModelDir(manifest!.id)

      expect(migratedModelDir).not.toContain(userDataDir)
      // State reads await asynchronous migration.
      await expect(manager.getModelState(manifest!.id)).resolves.toEqual({
        id: manifest!.id,
        status: 'ready'
      })
      for (const file of manifest!.files ?? []) {
        expect(existsSync(join(migratedModelDir, file))).toBe(true)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('deleting a migrated model removes the legacy copy so it is not resurrected on next launch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
    try {
      setPlatform('win32')
      const programDataDir = join(dir, 'ProgramData')
      const userDataDir = join(dir, '用户', 'Orca')
      process.env.PROGRAMDATA = programDataDir
      appGetPathMock.mockImplementation((name: string) =>
        name === 'userData' ? userDataDir : join(dir, name)
      )
      const manifest = SPEECH_MODEL_CATALOG.find(
        (model) => model.id === 'zipformer-streaming-zh-14m'
      )
      const legacyModelDir = join(userDataDir, 'speech-models', manifest!.id)
      for (const file of manifest!.downloadFiles ?? []) {
        const filePath = join(legacyModelDir, file.name)
        mkdirSync(dirname(filePath), { recursive: true })
        writeFileSync(filePath, '')
        truncateSync(filePath, file.sizeBytes)
      }

      const manager = new ModelManager(undefined, openElectronSpeechDownloadRequest)
      await expect(manager.getModelState(manifest!.id)).resolves.toEqual({
        id: manifest!.id,
        status: 'ready'
      })
      await manager.deleteModel(manifest!.id)

      // Deletion must prevent migration from resurrecting the model after restart.
      expect(existsSync(legacyModelDir)).toBe(false)

      const restarted = new ModelManager(undefined, openElectronSpeechDownloadRequest)
      await expect(restarted.getModelState(manifest!.id)).resolves.toEqual({
        id: manifest!.id,
        status: 'not-downloaded'
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
