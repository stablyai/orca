import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('PTY startup barrier ordering', () => {
  it('waits for local startup before resolving the provider for runtime and renderer spawns', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/ipc/pty.ts'), 'utf8').replaceAll(
      '\r\n',
      '\n'
    )
    const runtimeSpawnStart = source.indexOf('spawn: async (args) => {')
    const runtimeSpawnEnd = source.indexOf('      write:', runtimeSpawnStart)
    const runtimeSpawn = source.slice(runtimeSpawnStart, runtimeSpawnEnd)
    const rendererSpawnStart = source.indexOf("ipcMain.handle(\n    'pty:spawn'")
    const rendererSpawnEnd = source.indexOf("ipcMain.handle(\n    'pty:kill'", rendererSpawnStart)
    const rendererSpawn = source.slice(rendererSpawnStart, rendererSpawnEnd)

    for (const spawnBlock of [runtimeSpawn, rendererSpawn]) {
      const barrierIndex = spawnBlock.indexOf(
        'const startupPromise = getLocalPtyStartupPromise(args.connectionId)'
      )
      const providerIndex = spawnBlock.indexOf('const provider = getProvider(args.connectionId)')

      expect(barrierIndex).toBeGreaterThanOrEqual(0)
      expect(providerIndex).toBeGreaterThanOrEqual(0)
      expect(barrierIndex).toBeLessThan(providerIndex)
    }
  })
})
