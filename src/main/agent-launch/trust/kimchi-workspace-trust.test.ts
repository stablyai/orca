import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { markKimchiWorkspaceTrusted } from './agent-trust-presets'

describe('markKimchiWorkspaceTrusted', () => {
  it('grants only the selected workspace and preserves other trust decisions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-kimchi-trust-'))
    try {
      const workspace = join(root, 'workspace')
      const deniedWorkspace = join(root, 'denied')
      const home = join(root, 'home')
      const trustPath = join(home, '.config', 'kimchi', 'harness', 'trust.json')
      await mkdir(workspace, { recursive: true })
      await mkdir(dirname(trustPath), { recursive: true })
      const canonicalWorkspace = realpathSync(workspace)
      await writeFile(
        trustPath,
        JSON.stringify({ [canonicalWorkspace]: false, [deniedWorkspace]: false })
      )

      await markKimchiWorkspaceTrusted(workspace, home)

      expect(JSON.parse(await readFile(trustPath, 'utf-8'))).toEqual({
        [canonicalWorkspace]: true,
        [deniedWorkspace]: false
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
