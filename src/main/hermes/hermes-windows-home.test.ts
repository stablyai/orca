import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { resolveDefaultHermesSkillsRoot } from '../skills/skill-provider-runtime-roots'
import { getHermesHome, resolveDefaultHermesHome } from './hermes-home-filesystem'
import { HermesHookService } from './hook-service'

const homeDir = join('/users', 'alice')

function skillsHome(input: {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  directoryExists: (candidate: string) => boolean
}): string {
  return dirname(
    resolveDefaultHermesSkillsRoot({
      homeDir,
      platform: input.platform,
      env: input.env,
      directoryExists: input.directoryExists
    })
  )
}

describe('Hermes hook home', () => {
  it('follows skill discovery for every default-home case', () => {
    const localAppData = resolve('/local')
    const cases: {
      platform: NodeJS.Platform
      env: NodeJS.ProcessEnv
      directoryExists: (candidate: string) => boolean
    }[] = [
      {
        platform: 'linux',
        env: { LOCALAPPDATA: localAppData },
        directoryExists: () => true
      },
      {
        platform: 'win32',
        env: { LOCALAPPDATA: localAppData },
        directoryExists: (candidate) => candidate === join(localAppData, 'hermes')
      },
      {
        platform: 'win32',
        env: { LOCALAPPDATA: resolve('/local') },
        directoryExists: (candidate) => candidate === join(homeDir, '.hermes')
      },
      {
        platform: 'win32',
        env: { LOCALAPPDATA: localAppData },
        directoryExists: () => true
      },
      {
        platform: 'win32',
        env: { LOCALAPPDATA: 'relative\\local' },
        directoryExists: () => true
      }
    ]
    for (const input of cases) {
      expect(resolveDefaultHermesHome(input.env, { homeDir, ...input })).toBe(skillsHome(input))
    }
  })

  it('keeps an explicit HERMES_HOME ahead of the Windows default', () => {
    expect(
      getHermesHome(
        { HERMES_HOME: 'D:\\profiles\\hermes', LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' },
        { platform: 'win32', homeDir, directoryExists: () => true }
      )
    ).toBe('D:\\profiles\\hermes')
  })

  it('reports hook status for the Windows LOCALAPPDATA home', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const previousLocal = process.env.LOCALAPPDATA
    const previousHome = process.env.HERMES_HOME
    const root = mkdtempSync(join(tmpdir(), 'orca-hermes-win-'))
    const localAppData = join(root, 'Local')
    mkdirSync(join(localAppData, 'hermes'), { recursive: true })
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    process.env.LOCALAPPDATA = localAppData
    delete process.env.HERMES_HOME
    try {
      const installed = new HermesHookService().install()
      expect(installed.configPath).toBe(join(localAppData, 'hermes', 'config.yaml'))
      expect(installed.state).toBe('installed')
      expect(new HermesHookService().getStatus()).toMatchObject({
        state: 'installed',
        configPath: join(localAppData, 'hermes', 'config.yaml'),
        managedHooksPresent: true
      })
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
      if (previousLocal === undefined) {
        delete process.env.LOCALAPPDATA
      } else {
        process.env.LOCALAPPDATA = previousLocal
      }
      if (previousHome === undefined) {
        delete process.env.HERMES_HOME
      } else {
        process.env.HERMES_HOME = previousHome
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
})
