import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readHostManagedAgentCommands } from './managed-copy-detection'

it('leaves a PATH-installed Claude available to shell account routing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-claude-path-'))
  const bin = join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude')
  try {
    await writeFile(bin, '', { mode: 0o755 })
    expect(
      await readHostManagedAgentCommands({}, ['claude'], { pathEnv: dir, forDelivery: true })
    ).toEqual({})
  } finally {
    await unlink(bin)
    await rmdir(dir)
  }
})
