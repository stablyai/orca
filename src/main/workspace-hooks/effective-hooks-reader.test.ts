import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { WorkspaceHookOwner } from '../../shared/workspace-setup/hooks/workspace-hook-owner'
import { getDefaultRepoHookSettings } from '../../shared/workspace-setup/repo-hook-settings-defaults'
import { createEffectiveHooksReader } from './effective-hooks-reader'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
it('reads the checkout archive hook and a fresh reader sees a changed hook file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-hook-read-'))
  roots.push(root)
  const checkout = join(root, 'checkout')
  mkdirSync(checkout)
  const owner: WorkspaceHookOwner = {
    id: 'repo',
    path: root,
    displayName: 'Repo',
    kind: 'git',
    hookSettings: {
      ...getDefaultRepoHookSettings(),
      commandSourcePolicy: 'shared-only',
      scripts: { setup: '', archive: 'local cleanup' }
    }
  }
  writeFileSync(join(root, 'orca.yaml'), 'scripts:\n  archive: root cleanup\n')
  writeFileSync(join(checkout, 'orca.yaml'), 'scripts:\n  archive: checkout cleanup\n')
  const read = createEffectiveHooksReader()
  expect((await read(owner, checkout))?.scripts.archive).toBe('checkout cleanup')
  writeFileSync(join(checkout, 'orca.yaml'), 'scripts:\n  archive: changed cleanup\n')
  expect((await read(owner, checkout))?.scripts.archive).toBe('checkout cleanup')
  expect((await createEffectiveHooksReader()(owner, checkout))?.scripts.archive).toBe(
    'changed cleanup'
  )
})
