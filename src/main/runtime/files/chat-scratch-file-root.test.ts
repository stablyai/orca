import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeStore } from '../runtime-store-contract'
import { resolveRuntimeAuthorizedPath } from './chat-scratch-file-root'

function makeStore(settings: Record<string, unknown> = {}): RuntimeStore {
  return {
    getRepos: () => [],
    getProjects: () => [],
    getProjectGroups: () => [],
    getFolderWorkspaces: () => [],
    getSettings: () => ({ nestWorkspaces: false, workspaceDir: '', ...settings })
  } as unknown as RuntimeStore
}

describe('resolveRuntimeAuthorizedPath', () => {
  let base: string

  beforeEach(async () => {
    base = await mkdtemp(join(await realpath(tmpdir()), 'orca-scratch-test-'))
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('allows files in a trusted floatingTerminalCwd directory', async () => {
    const trustedDir = join(base, 'trusted-floating-dir')
    await mkdir(trustedDir)
    const file = join(trustedDir, 'index.html')
    await writeFile(file, 'hello')

    const store = makeStore({
      floatingTerminalCwd: trustedDir,
      floatingTerminalTrustedCwds: [trustedDir]
    })

    await expect(resolveRuntimeAuthorizedPath(file, store)).resolves.toBe(file)
  })

  it('refuses files in an untrusted floatingTerminalCwd directory', async () => {
    const untrustedDir = join(base, 'untrusted-floating-dir')
    await mkdir(untrustedDir)
    const file = join(untrustedDir, 'index.html')
    await writeFile(file, 'hello')

    const store = makeStore({
      floatingTerminalCwd: untrustedDir,
      floatingTerminalTrustedCwds: []
    })

    await expect(resolveRuntimeAuthorizedPath(file, store)).rejects.toThrow('Access denied')
  })
})
