import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveCommand } from './wsl-command-resolution'

const originalPlatform = process.platform
const QUARANTINE = {
  GIT_OBJECT_DIRECTORY: '/home/me/repo/.git/objects/tmp_objdir-orca-merge-tree-x',
  GIT_ALTERNATE_OBJECT_DIRECTORIES: '/home/me/repo/.git/objects'
}

/** What WSL Git would see when a login profile has set `profileAlternates` before the payload runs. */
async function alternatesSeenByWslGit(profileAlternates: string | undefined): Promise<string> {
  const resolved = resolveCommand('git', [], undefined, 'Ubuntu', {
    env: { ...process.env, ...QUARANTINE },
    wslShellCommand: 'printenv GIT_ALTERNATE_OBJECT_DIRECTORIES'
  })
  const payload = resolved.args.at(-1) ?? ''
  const profile =
    profileAlternates === undefined
      ? ''
      : `export GIT_ALTERNATE_OBJECT_DIRECTORIES='${profileAlternates}'; `
  const result = await runProcess({ program: 'sh', args: ['-c', `${profile}${payload}`] })
  expect(result.code).toBe(0)
  return result.stdout.trim()
}

// Login profiles must not replace the quarantine's WSLENV-forwarded object-store values.
describe.skipIf(originalPlatform === 'win32')('WSL Git object-store variables', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  it('applies the editor override in the guest after the login profile', async () => {
    const resolved = resolveCommand('git', ['cherry-pick', '--continue'], undefined, 'Ubuntu', {
      env: { GIT_EDITOR: 'true' },
      wslShellCommand: 'sh -c \'"$GIT_EDITOR"\''
    })
    const result = await runProcess({
      program: 'sh',
      args: ['-c', `export GIT_EDITOR=false; ${resolved.args.at(-1)}`]
    })
    expect(result.code).toBe(0)
  })

  it('reach WSL Git after the login profile, appending to its alternates', async () => {
    await expect(alternatesSeenByWslGit(undefined)).resolves.toBe('/home/me/repo/.git/objects')
    await expect(alternatesSeenByWslGit('/shared/objects')).resolves.toBe(
      '/shared/objects:/home/me/repo/.git/objects'
    )
  })
})
