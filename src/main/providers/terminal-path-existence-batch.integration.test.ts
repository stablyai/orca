import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>())
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, fn)
  },
  shell: {},
  dialog: {}
}))
import { registerShellHandlers } from '../ipc/shell'
let root: string | undefined
afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  root = undefined
  handlers.clear()
})
async function fixture() {
  root = await mkdtemp(join(tmpdir(), 'orca-link-batch-'))
  const paths = Array.from({ length: 8 }, (_, i) => join(root!, `file-${i}.ts`))
  await Promise.all(paths.map((path) => writeFile(path, 'fixture')))
  return paths
}
it('one actual shell IPC handler probes eight distinct temporary files and retains scalar answers', async () => {
  const paths = await fixture()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This registration fixture never invokes unrelated store operations.
  registerShellHandlers({} as never)
  const all = [...paths, join(root!, 'missing'), root!]
  expect(await handlers.get('shell:pathsExist')!(null, all)).toEqual(
    await Promise.all(all.map((path) => handlers.get('shell:pathExists')!(null, path)))
  )
  expect(await handlers.get('shell:pathsExist')!(null, all)).toEqual([
    ...paths.map(() => true),
    false,
    true
  ])
  await expect(handlers.get('shell:pathsExist')!(null, Array(129).fill('x'))).rejects.toThrow(
    'Invalid'
  )
})
