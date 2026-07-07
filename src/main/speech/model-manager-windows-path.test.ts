import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SPEECH_MODEL_CATALOG } from './model-catalog'
import { ModelManager } from './model-manager'

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

function isAsciiPath(value: string): boolean {
  return [...value].every((character) => character.charCodeAt(0) <= 0x7f)
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

  it('uses an ASCII cache path when the Windows default user data path has non-ASCII characters', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
    try {
      setPlatform('win32')
      const programDataDir = join(dir, 'ProgramData')
      const userDataDir = join(dir, '用户', 'Orca')
      process.env.PROGRAMDATA = programDataDir
      appGetPathMock.mockImplementation((name: string) =>
        name === 'userData' ? userDataDir : join(dir, name)
      )

      const manager = new ModelManager()

      expect(manager.getModelsDir()).not.toContain(userDataDir)
      expect(manager.getModelsDir()).toContain(join(programDataDir, 'Orca', 'speech-models'))
      expect(isAsciiPath(manager.getModelsDir())).toBe(true)
      expect(existsSync(manager.getModelsDir())).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
      const manifest = SPEECH_MODEL_CATALOG.find((model) => model.provider === 'local')
      expect(manifest?.files).toBeDefined()
      const legacyModelDir = join(userDataDir, 'speech-models', manifest!.id)
      for (const file of manifest!.files ?? []) {
        const filePath = join(legacyModelDir, file)
        mkdirSync(dirname(filePath), { recursive: true })
        writeFileSync(filePath, 'model file')
      }

      const manager = new ModelManager()
      const migratedModelDir = manager.getModelDir(manifest!.id)

      expect(migratedModelDir).not.toContain(userDataDir)
      // Migration runs asynchronously; getModelState awaits it before reading files.
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
      const manifest = SPEECH_MODEL_CATALOG.find((model) => model.provider === 'local')
      const legacyModelDir = join(userDataDir, 'speech-models', manifest!.id)
      for (const file of manifest!.files ?? []) {
        const filePath = join(legacyModelDir, file)
        mkdirSync(dirname(filePath), { recursive: true })
        writeFileSync(filePath, 'model file')
      }

      const manager = new ModelManager()
      await expect(manager.getModelState(manifest!.id)).resolves.toEqual({
        id: manifest!.id,
        status: 'ready'
      })
      await manager.deleteModel(manifest!.id)

      // The legacy source copy must be gone so migration cannot re-seed it.
      expect(existsSync(legacyModelDir)).toBe(false)

      // Simulate an app restart: a fresh manager migrates from the same source.
      const restarted = new ModelManager()
      await expect(restarted.getModelState(manifest!.id)).resolves.toEqual({
        id: manifest!.id,
        status: 'not-downloaded'
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
