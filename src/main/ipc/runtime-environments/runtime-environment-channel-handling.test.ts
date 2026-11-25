import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RUNTIME_ENVIRONMENT_HANDLER_CHANNELS } from './runtime-environment-handler-channels'

const ROOT = join(__dirname, '../../../..')

function sources(directory: string): string[] {
  return readdirSync(join(ROOT, directory), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .map((file) => readFileSync(join(ROOT, directory, file), 'utf8'))
}

// The shared-host table is typed against the channel list; these keep every channel on that list.
describe('runtimeEnvironments channels', () => {
  it('lists every channel the window invokes, so each has a shared-host decision', () => {
    const invoked = new Set(
      sources('src/preload').flatMap((source) =>
        [...source.matchAll(/invoke\(\s*'(runtimeEnvironments:[A-Za-z]+)'/g)].map((m) => m[1])
      )
    )
    const listed = new Set<string>(RUNTIME_ENVIRONMENT_HANDLER_CHANNELS)
    expect(invoked.size).toBeGreaterThan(0)
    expect([...invoked].filter((channel) => !listed.has(channel))).toEqual([])
  })

  it('registers none around handleRuntimeEnvironmentChannel', () => {
    const raw = sources('src/main').filter((source) =>
      /ipcMain\.handle\(\s*'runtimeEnvironments:/.test(source)
    )
    expect(raw).toEqual([])
  })
})
