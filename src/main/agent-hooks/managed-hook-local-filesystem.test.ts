import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installRemoteManagedAgentHooks } from './remote-managed-hook-installers'
import { createManagedHookLocalFilesystem } from './managed-hook-local-filesystem'

const tempHomes: string[] = []

async function createTempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'orca-managed-hooks-'))
  tempHomes.push(home)
  return home
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name)
      return entry.isDirectory() ? await listFiles(path) : [path]
    })
  )
  return nested.flat()
}

afterEach(async () => {
  await Promise.all(tempHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

describe('managed-hook local filesystem', () => {
  it('supports cold and warm aggregate installs without SFTP or temp-file residue', async () => {
    const home = await createTempHome()
    const filesystem = createManagedHookLocalFilesystem()
    const options = { grokHomeDir: join(home, '.grok') }

    const cold = await installRemoteManagedAgentHooks(filesystem, home, options)
    const warm = await installRemoteManagedAgentHooks(filesystem, home, options)

    expect(cold).toHaveLength(14)
    expect(cold.filter((result) => result.state === 'error')).toEqual([])
    expect(warm).toHaveLength(14)
    expect(warm.filter((result) => result.state === 'error')).toEqual([])
    const files = await listFiles(home)
    expect(files.filter((path) => path.endsWith('.tmp'))).toEqual([])
    const scripts = files.filter((path) => path.includes(join('.orca', 'agent-hooks')))
    expect(scripts.length).toBeGreaterThanOrEqual(10)
    if (process.platform !== 'win32') {
      for (const script of scripts) {
        expect((await stat(script)).mode & 0o777).toBe(0o755)
      }
    }
  })

  it('isolates a malformed config while installing the remaining agents', async () => {
    const home = await createTempHome()
    const claudeConfig = join(home, '.claude', 'settings.json')
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(claudeConfig, '{"hooks": }', 'utf8')

    const results = await installRemoteManagedAgentHooks(createManagedHookLocalFilesystem(), home, {
      grokHomeDir: join(home, '.grok')
    })

    expect(results).toHaveLength(14)
    expect(results.find((result) => result.agent === 'claude')?.state).toBe('error')
    expect(results.find((result) => result.agent === 'openclaude')?.state).toBe('installed')
    expect(results.find((result) => result.agent === 'kimi')?.state).toBe('installed')
    expect(await readFile(claudeConfig, 'utf8')).toBe('{"hooks": }')
  })
})
