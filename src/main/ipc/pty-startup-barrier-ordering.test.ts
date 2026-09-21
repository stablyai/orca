import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function readRepoSource(relPath: string): string {
  return readFileSync(join(process.cwd(), relPath), 'utf8').replace(/\r\n?/g, '\n')
}

describe('PTY startup barrier ordering', () => {
  it('waits for local startup before resolving the provider for runtime and renderer spawns', () => {
    const runtimeSpawn =
      readRepoSource('src/main/ipc/pty/runtime/spawn.ts') +
      readRepoSource('src/main/ipc/pty/runtime/spawn-early.ts') +
      readRepoSource('src/main/ipc/pty/runtime/spawn-preflight.ts')

    const rendererSource =
      readRepoSource('src/main/ipc/pty/ipc/spawn.ts') +
      readRepoSource('src/main/ipc/pty/ipc/spawn-begin.ts') +
      readRepoSource('src/main/ipc/pty/ipc/spawn-preflight.ts')
    const rendererSpawnStart = rendererSource.indexOf("ipcMain.handle('pty:spawn'")
    const rendererSpawn = rendererSource.slice(rendererSpawnStart)

    for (const spawnBlock of [runtimeSpawn, rendererSpawn]) {
      const barrierIndex = spawnBlock.indexOf('getLocalPtyStartupPromise(args.connectionId)')
      const providerIndex = spawnBlock.indexOf('getProvider(args.connectionId)')

      expect(barrierIndex).toBeGreaterThanOrEqual(0)
      expect(providerIndex).toBeGreaterThanOrEqual(0)
      expect(barrierIndex).toBeLessThan(providerIndex)
    }
  })
})
