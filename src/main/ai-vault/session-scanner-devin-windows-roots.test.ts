import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AI_VAULT_AGENT_SOURCES } from './session-scanner-agent-sources'
import {
  defaultDevinTranscriptsSegments,
  resolveDevinTranscriptsDir
} from './session-scanner-devin-paths'
import { remoteSessionSources } from './remote-session-scanner-sources'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { buildAiVaultServiceEnv } from './session-scanner-service-env'

function stubPlatform(platform: NodeJS.Platform): () => void {
  const previous = process.platform
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  return () => {
    Object.defineProperty(process, 'platform', { value: previous, configurable: true })
  }
}

function devinRemoteRoot(
  remoteHome: string,
  relayPlatform: 'win32-x64' | 'linux-x64' | 'darwin-arm64',
  devinTranscriptsDir?: string
): string {
  const source = remoteSessionSources(
    remoteHome,
    getRemoteHostPlatform(relayPlatform),
    devinTranscriptsDir
  ).find((entry) => entry.agent === 'devin')
  if (!source) {
    throw new Error('missing Devin remote source')
  }
  return source.rootDir
}

describe('Devin transcript roots on Windows', () => {
  const previousAppData = process.env.APPDATA
  const previousDevinHome = process.env.DEVIN_HOME

  afterEach(() => {
    if (previousAppData === undefined) {
      delete process.env.APPDATA
    } else {
      process.env.APPDATA = previousAppData
    }
    if (previousDevinHome === undefined) {
      delete process.env.DEVIN_HOME
    } else {
      process.env.DEVIN_HOME = previousDevinHome
    }
  })

  it('scans %APPDATA%/devin/cli/transcripts on a Windows host when DEVIN_HOME is unset', () => {
    delete process.env.DEVIN_HOME
    process.env.APPDATA = 'C:\\Users\\Ada\\AppData\\Roaming'
    const restore = stubPlatform('win32')
    try {
      const [hostRoot] = AI_VAULT_AGENT_SOURCES.devin.rootDirs({}, [])
      expect(hostRoot).toBe(join('C:\\Users\\Ada\\AppData\\Roaming', 'devin', 'cli', 'transcripts'))
    } finally {
      restore()
    }
  })

  it('falls back to home/AppData/Roaming when APPDATA is unset on Windows', () => {
    delete process.env.DEVIN_HOME
    delete process.env.APPDATA
    const restore = stubPlatform('win32')
    try {
      const [hostRoot] = AI_VAULT_AGENT_SOURCES.devin.rootDirs({}, [])
      expect(hostRoot).toBe(join(homedir(), 'AppData', 'Roaming', 'devin', 'cli', 'transcripts'))
    } finally {
      restore()
    }
  })

  it('keeps WSL extra homes on the Linux XDG layout even when the host is Windows', () => {
    delete process.env.DEVIN_HOME
    process.env.APPDATA = 'C:\\Users\\Ada\\AppData\\Roaming'
    const restore = stubPlatform('win32')
    try {
      const roots = AI_VAULT_AGENT_SOURCES.devin.rootDirs({}, ['/home/ada'])
      expect(roots).toEqual([
        join('C:\\Users\\Ada\\AppData\\Roaming', 'devin', 'cli', 'transcripts'),
        join('/home/ada', '.local', 'share', 'devin', 'cli', 'transcripts')
      ])
    } finally {
      restore()
    }
  })

  it('honors DEVIN_HOME over the Windows default', () => {
    process.env.DEVIN_HOME = 'D:\\devin-home'
    process.env.APPDATA = 'C:\\Users\\Ada\\AppData\\Roaming'
    const restore = stubPlatform('win32')
    try {
      const [hostRoot] = AI_VAULT_AGENT_SOURCES.devin.rootDirs({}, [])
      expect(hostRoot).toBe(join('D:\\devin-home', 'transcripts'))
    } finally {
      restore()
    }
  })

  it('leaves POSIX local defaults on the Linux XDG layout', () => {
    delete process.env.DEVIN_HOME
    const restore = stubPlatform('linux')
    try {
      const [hostRoot] = AI_VAULT_AGENT_SOURCES.devin.rootDirs({}, [])
      expect(hostRoot).toBe(join(homedir(), '.local', 'share', 'devin', 'cli', 'transcripts'))
    } finally {
      restore()
    }
  })
})

describe('Devin remote transcript roots', () => {
  it('uses AppData/Roaming on a Windows remote host', () => {
    expect(devinRemoteRoot('C:/Users/Ada', 'win32-x64')).toBe(
      'C:/Users/Ada/AppData/Roaming/devin/cli/transcripts'
    )
  })

  it('keeps the XDG layout on POSIX remote hosts', () => {
    expect(devinRemoteRoot('/home/ada', 'linux-x64')).toBe(
      '/home/ada/.local/share/devin/cli/transcripts'
    )
    expect(devinRemoteRoot('/Users/ada', 'darwin-arm64')).toBe(
      '/Users/ada/.local/share/devin/cli/transcripts'
    )
  })

  it('uses a relay-resolved root instead of the home fallback', () => {
    expect(
      devinRemoteRoot(
        'C:/Users/Ada',
        'win32-x64',
        'D:\\Profiles\\Ada\\Roaming\\devin\\cli\\transcripts'
      )
    ).toBe('D:/Profiles/Ada/Roaming/devin/cli/transcripts')
  })
})

describe('AI Vault scanner child env for Devin on Windows', () => {
  it('preserves redirected APPDATA through child env and root resolution', () => {
    const env = buildAiVaultServiceEnv({ APPDATA: 'D:\\Profiles\\Ada\\Roaming' }, 'win32')

    expect(
      resolveDevinTranscriptsDir({
        env,
        homeDir: 'C:\\Users\\Ada',
        platform: 'win32'
      })
    ).toBe(join('D:\\Profiles\\Ada\\Roaming', 'devin', 'cli', 'transcripts'))
  })
})

describe('resolveDevinTranscriptsDir', () => {
  it('uses APPDATA on win32 when DEVIN_HOME is unset', () => {
    expect(
      resolveDevinTranscriptsDir({
        platform: 'win32',
        homeDir: '/Users/ada',
        env: { APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming' }
      })
    ).toBe(join('C:\\Users\\Ada\\AppData\\Roaming', 'devin', 'cli', 'transcripts'))
  })

  it('falls back to home AppData/Roaming on win32 when APPDATA is unset', () => {
    expect(
      resolveDevinTranscriptsDir({
        platform: 'win32',
        homeDir: '/Users/ada',
        env: {}
      })
    ).toBe(join('/Users/ada', 'AppData', 'Roaming', 'devin', 'cli', 'transcripts'))
  })

  it('lets DEVIN_HOME win on every platform', () => {
    expect(
      resolveDevinTranscriptsDir({
        platform: 'win32',
        homeDir: '/Users/ada',
        env: { DEVIN_HOME: 'D:\\devin-home', APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming' }
      })
    ).toBe(join('D:\\devin-home', 'transcripts'))
  })

  it('lets an explicit override win over env and platform defaults', () => {
    expect(
      resolveDevinTranscriptsDir({
        override: '/tmp/custom-devin',
        platform: 'win32',
        env: { DEVIN_HOME: 'D:\\devin-home' }
      })
    ).toBe('/tmp/custom-devin')
  })

  it.each(['', '  '])('preserves a defined explicit override verbatim: %j', (override) => {
    expect(AI_VAULT_AGENT_SOURCES.devin.rootDirs({ devinTranscriptsDir: override }, [])).toEqual([
      override
    ])
  })

  it('keeps the XDG layout on POSIX hosts', () => {
    expect(
      resolveDevinTranscriptsDir({
        platform: 'darwin',
        homeDir: '/Users/ada',
        env: {}
      })
    ).toBe(join('/Users/ada', '.local', 'share', 'devin', 'cli', 'transcripts'))
  })

  it('returns Windows segments only for win32 remotes', () => {
    expect(defaultDevinTranscriptsSegments('win32')).toEqual([
      'AppData',
      'Roaming',
      'devin',
      'cli',
      'transcripts'
    ])
    expect(defaultDevinTranscriptsSegments('linux')).toEqual([
      '.local',
      'share',
      'devin',
      'cli',
      'transcripts'
    ])
    expect(defaultDevinTranscriptsSegments('darwin')).toEqual([
      '.local',
      'share',
      'devin',
      'cli',
      'transcripts'
    ])
  })
})
