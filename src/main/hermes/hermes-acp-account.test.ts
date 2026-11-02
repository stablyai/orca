import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hermesAcpAccountBinding } from './hermes-acp-account'

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

describe('Hermes ACP account home', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    if (realPlatform) {
      Object.defineProperty(process, 'platform', realPlatform)
    }
  })

  it('pins an absolute HERMES_HOME from the launch env', async () => {
    vi.stubEnv('HERMES_HOME', '/data/from-process')
    const home = await hermesAcpAccountBinding().resolve({
      launchEnv: { HERMES_HOME: '/data/launch' },
      stateDirectory: '/orca-data'
    })
    expect(home).toEqual({ variable: 'HERMES_HOME', path: '/data/launch' })
  })

  it('rejects a relative HERMES_HOME and uses the default dotfolder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-hermes-home-'))
    try {
      vi.stubEnv('HERMES_HOME', 'relative/from-process')
      const home = await hermesAcpAccountBinding().resolve({
        launchEnv: { HERMES_HOME: 'relative/hermes', HOME: root, LOCALAPPDATA: '' },
        stateDirectory: '/orca-data'
      })
      expect(home).toEqual({ variable: 'HERMES_HOME', path: join(root, '.hermes') })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses an absolute HERMES_HOME from the process when the launch env omits it', async () => {
    vi.stubEnv('HERMES_HOME', '/data/from-process')
    const home = await hermesAcpAccountBinding().resolve({
      launchEnv: {},
      stateDirectory: '/orca-data'
    })
    expect(home).toEqual({ variable: 'HERMES_HOME', path: '/data/from-process' })
  })

  it('uses %LOCALAPPDATA%\\hermes on Windows when that tree exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-hermes-win-'))
    try {
      const localHome = join(root, 'Local', 'hermes')
      mkdirSync(localHome, { recursive: true })
      mkdirSync(join(root, 'profile', '.hermes'), { recursive: true })
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      vi.stubEnv('HERMES_HOME', '')
      vi.stubEnv('LOCALAPPDATA', '')
      const home = await hermesAcpAccountBinding().resolve({
        launchEnv: { HOME: join(root, 'profile'), LOCALAPPDATA: join(root, 'Local') },
        stateDirectory: '/orca-data'
      })
      expect(home).toEqual({ variable: 'HERMES_HOME', path: localHome })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps an existing dotfolder on Windows when the LOCALAPPDATA tree is absent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-hermes-win-dot-'))
    try {
      const dotfolder = join(root, 'profile', '.hermes')
      mkdirSync(dotfolder, { recursive: true })
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
      vi.stubEnv('HERMES_HOME', '')
      const home = await hermesAcpAccountBinding().resolve({
        launchEnv: { HOME: join(root, 'profile'), LOCALAPPDATA: join(root, 'Local') },
        stateDirectory: '/orca-data'
      })
      expect(home).toEqual({ variable: 'HERMES_HOME', path: dotfolder })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('writes HERMES_HOME and refuses another account kind', () => {
    const binding = hermesAcpAccountBinding()
    expect(
      binding.environment({ variable: 'HERMES_HOME', path: '/data/hermes' }, { PATH: 'x' })
    ).toEqual({ PATH: 'x', HERMES_HOME: '/data/hermes' })
    expect(() => binding.environment({ variable: 'GROK_HOME', path: '/data/grok' }, {})).toThrow(
      /HERMES_HOME/
    )
  })
})
