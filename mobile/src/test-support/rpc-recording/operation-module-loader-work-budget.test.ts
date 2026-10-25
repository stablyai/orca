import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import type * as FsModule from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { nativeMountingSubstitutes } from './native-mounting-substitutes'
import type * as NativeSubstitutesModule from './native-mounting-substitutes'
import { operationModuleLoader } from './operation-module-loader'

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof FsModule>()
  return { ...fs, existsSync: vi.fn(fs.existsSync) }
})

vi.mock('./native-mounting-substitutes', async (original) => {
  const module = await original<typeof NativeSubstitutesModule>()
  return { ...module, nativeMountingSubstitutes: vi.fn(module.nativeMountingSubstitutes) }
})

const roots: string[] = []

function sourceTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'rpc-loader-work-budget-'))
  roots.push(root)
  mkdirSync(join(root, 'mobile', 'src'), { recursive: true })
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(root, 'mobile', 'src', name), source)
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

it('resolves a relative import once instead of probing disk on every exported member read', () => {
  const root = sourceTree({
    'value.ts': 'export const value = 42',
    'operation.ts': `import { value } from './value'; export const read = () => value`
  })
  const operation = operationModuleLoader(root).load<{ read: () => number }>(
    'mobile/src/operation.ts'
  )
  expect(operation.read()).toBe(42)
  vi.mocked(existsSync).mockClear()
  for (let index = 0; index < 1_000; index++) {
    expect(operation.read()).toBe(42)
  }
  expect(existsSync).not.toHaveBeenCalled()
})

it('builds device substitutes only for a used loader and keeps their state per loader', async () => {
  const root = sourceTree({
    'operation.ts': `
      import * as clipboard from 'expo-clipboard'
      export const read = () => clipboard.getStringAsync()
      export const write = () => clipboard.setStringAsync('first recording')
    `
  })
  const loaders = Array.from({ length: 64 }, () => operationModuleLoader(root))
  expect(nativeMountingSubstitutes).not.toHaveBeenCalled()
  type ClipboardOperation = { read: () => Promise<string>; write: () => Promise<void> }
  const first = loaders[0].load<ClipboardOperation>('mobile/src/operation.ts')
  await first.write()
  expect(await first.read()).toBe('first recording')
  expect(nativeMountingSubstitutes).toHaveBeenCalledTimes(1)
  const second = loaders[1].load<ClipboardOperation>('mobile/src/operation.ts')
  expect(await second.read()).toBe('')
  expect(await first.read()).toBe('first recording')
  expect(nativeMountingSubstitutes).toHaveBeenCalledTimes(2)
})
