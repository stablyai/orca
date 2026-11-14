import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { readCodexCliVersion } from '../codex/structured/launch/codex-cli-installation-error'

import type * as CommandResolution from '../../shared/node-cli-command-resolution'

vi.mock('../startup/shell-environment/login-shell-environment', () => ({
  resolveLoginShellEnvironment: async () => ({})
}))
vi.mock('../../shared/node-cli-command-resolution', async (original) => {
  const actual = await original<typeof CommandResolution>()
  return {
    ...actual,
    // Keep the stock resolver from substituting any real host installation.
    resolveCliCommand: (name: string) => name
  }
})

let root: string | undefined
afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

describe.skipIf(process.platform === 'win32')('workspace-relative Codex selection', () => {
  it('resolves a relative command path before probing it', async () => {
    root = await mkdtemp(join(tmpdir(), 'codex-relative-command-'))
    await mkdir(join(root, 'bin'))
    const file = join(root, 'bin', 'codex')
    await writeFile(file, `#!${process.execPath}\nconsole.log('codex-cli 0.136.0')\n`, {
      mode: 0o755
    })
    const input = { program: join('bin', 'codex'), cwd: root, env: { PATH: '' } }
    expect(await readCodexCliVersion(input)).toEqual({ version: '0.136.0' })
    await writeFile(file, `#!${process.execPath}\nconsole.log('codex-cli 0.135.0')\n`, {
      mode: 0o755
    })
    expect(await readCodexCliVersion(input)).toEqual({ version: '0.135.0' })
  })
})
