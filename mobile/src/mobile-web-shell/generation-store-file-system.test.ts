import { describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  write: vi.fn<(value: string | Uint8Array) => Promise<void>>(),
  copy: vi.fn<() => Promise<void>>(),
  move: vi.fn<() => Promise<void>>()
}))

vi.mock('expo-file-system', () => ({
  Directory: class {
    readonly uri = 'file:///cache'
    create(): void {}
    move = native.move
  },
  File: class {
    readonly parentDirectory = { create() {} }
    create(): void {}
    write = native.write
    copy = native.copy
  },
  Paths: { cache: '' }
}))

import {
  createExpoGenerationFileSystem,
  generationDirectoryPath,
  type GenerationFileSystem
} from './generation-store-file-system'

describe('native generation mutations', () => {
  const cases = [
    {
      name: 'bytes',
      operation: native.write,
      run: (fs: GenerationFileSystem) => fs.writeBytes('file:///bytes', new Uint8Array([1]))
    },
    {
      name: 'text',
      operation: native.write,
      run: (fs: GenerationFileSystem) => fs.writeText('file:///text', 'manifest')
    },
    {
      name: 'copy',
      operation: native.copy,
      run: (fs: GenerationFileSystem) => fs.copyFile('file:///source', 'file:///target')
    },
    {
      name: 'move',
      operation: native.move,
      run: (fs: GenerationFileSystem) => fs.moveDirectory('file:///source', 'file:///target')
    }
  ]

  it.each(cases)(
    'waits for $name before allowing the generation to be published',
    async ({ operation, run }) => {
      let complete = () => {}
      operation.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          complete = resolve
        })
      )
      let settled = false
      const pending = run(createExpoGenerationFileSystem()).then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)
      complete()
      await pending
      expect(settled).toBe(true)
    }
  )

  it.each(cases)(
    'propagates a failed $name instead of publishing a partial generation',
    async ({ operation, run }) => {
      operation.mockRejectedValueOnce(new Error('disk unavailable'))
      await expect(run(createExpoGenerationFileSystem())).rejects.toThrow('disk unavailable')
    }
  )
})

describe('generationDirectoryPath', () => {
  it('hands the native view the absolute path both loaders demand', () => {
    // Both refuse anything without a leading slash, and the store speaks file:// uris.
    expect(
      generationDirectoryPath('file:///var/mobile/Caches/mobile-web/abc/generations/def')
    ).toBe('/var/mobile/Caches/mobile-web/abc/generations/def')
    expect(generationDirectoryPath('file:///data/user/0/com.stably.orca.mobile/cache/mw')).toBe(
      '/data/user/0/com.stably.orca.mobile/cache/mw'
    )
  })

  it('decodes what a uri escaped and a path spells literally', () => {
    expect(generationDirectoryPath('file:///var/Orca%20Mobile/mobile-web')).toBe(
      '/var/Orca Mobile/mobile-web'
    )
  })

  it('leaves a value that is already a path alone, so nobody can decode one twice', () => {
    expect(generationDirectoryPath('/var/mobile/Caches/100%25')).toBe('/var/mobile/Caches/100%25')
  })
})
