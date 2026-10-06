import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readConventionalProfileAliases, type ProfileHostContext } from './host-discovery'

describe('conventional alias reader', () => {
  it('reads only conventional files, skips missing files and refuses oversize ambiguity', async () => {
    const home = await mkdtemp(join(tmpdir(), 'profile-alias-'))
    const host: ProfileHostContext = {
      home,
      shell: '/bin/zsh',
      platform: 'linux',
      hostId: 'local',
      isWsl: false
    }
    try {
      await writeFile(join(home, '.zsh_aliases'), '# synthetic aliases')
      await writeFile(join(home, 'private'), 'never read')
      expect(await readConventionalProfileAliases(host)).toEqual([
        { name: join(home, '.zsh_aliases'), content: '# synthetic aliases' }
      ])
      await writeFile(join(home, '.zshrc'), 'x'.repeat(1024 * 1024 + 1))
      await expect(readConventionalProfileAliases(host)).rejects.toThrow(/safely/)
      expect(await readConventionalProfileAliases({ ...host, shell: '/bin/fish' })).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
