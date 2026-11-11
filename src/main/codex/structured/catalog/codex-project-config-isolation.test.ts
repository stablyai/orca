import { afterEach, expect, it, vi } from 'vitest'
import { codexProjectConfigIsolationArgs } from './codex-project-config-isolation'

afterEach(() => vi.unstubAllGlobals())

it("also untrusts Windows Codex's lowercased key, which an exact saved entry would otherwise win", async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  expect(await codexProjectConfigIsolationArgs('C:\\Users\\Ärla\\Repo')).toEqual([
    '-c',
    'projects={"C:\\\\Users\\\\Ärla\\\\Repo"={trust_level="untrusted"},"c:\\\\users\\\\Ärla\\\\repo"={trust_level="untrusted"}}'
  ])
})
