import { chmod, lstat, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  linkDirectory,
  makeSkillHome,
  NAME,
  NEW_TEXT,
  previewAndInstall,
  removeSkillHomes,
  serviceInput,
  writeCopy
} from './testing/bundled-skill-home'

afterEach(removeSkillHomes)

describe.skipIf(process.platform === 'win32')('bundled skill backup permissions', () => {
  it('keeps a backed-up symlink from changing its target permissions', async () => {
    const home = await makeSkillHome()
    const outside = join(home.root, 'outside', NAME)
    await writeCopy(outside, NEW_TEXT)
    await chmod(outside, 0o755)
    await mkdir(dirname(home.shared), { recursive: true })
    await linkDirectory(outside, home.shared)

    const { result } = await previewAndInstall(serviceInput(home, { force: [home.shared] }))
    const backup = result.skills[0].ops[0].backupPath ?? ''

    expect((await lstat(backup)).isSymbolicLink()).toBe(true)
    expect((await lstat(outside)).mode & 0o777).toBe(0o755)
    expect((await lstat(dirname(backup))).mode & 0o777).toBe(0o700)
  })
})
