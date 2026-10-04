import { describe, expect, it } from 'vitest'
import { zstdCompressSync } from 'node:zlib'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { remoteSessionSources } from './remote-session-scanner-sources'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { jsonLines, MemoryRemoteProvider } from './remote-session-scanner-test-fixtures'
import type { RemoteSessionFilesystemProvider } from './remote-session-scanner-types'

const remoteHome = '/host/home'
const dshSessionsDir = '/host/custom-dsh/sessions'
const hostPlatform = getRemoteHostPlatform('linux-x64')

describe('combined execution-host history options', () => {
  it('preserves each positional setting and the legacy IDE default', () => {
    const defaults = remoteSessionSources(remoteHome, hostPlatform)
    expect(defaults.filter((source) => source.agent === 'antigravity')).toHaveLength(1)
    expect(defaults.find((source) => source.agent === 'dsh')?.rootDir).toBe(
      '/host/home/.dsh/sessions'
    )
    expect(
      remoteSessionSources(remoteHome, hostPlatform, true).filter(
        (source) => source.agent === 'antigravity'
      )
    ).toHaveLength(3)
    const custom = remoteSessionSources(remoteHome, hostPlatform, dshSessionsDir)
    expect(custom.find((source) => source.agent === 'dsh')?.rootDir).toBe(dshSessionsDir)
    expect(custom.filter((source) => source.agent === 'antigravity')).toHaveLength(1)
  })

  it('scans custom compressed DSH and opted-in IDE history together on the owning host', async () => {
    const memory = new MemoryRemoteProvider()
    const dshPath = `${dshSessionsDir}/project/combined-dsh/session.v4.jsonl.zstd`
    const idePath =
      '/host/home/.gemini/antigravity-ide/brain/combined-ide/.system_generated/logs/transcript.jsonl'
    const compressed = zstdCompressSync(
      Buffer.from(
        jsonLines([
          {
            type: 'session',
            version: 4,
            id: 'combined-dsh',
            cwd: '/host/plain-folder',
            createdAt: 1790920000000,
            isSeeded: false,
            delegationDepth: 0
          },
          {
            type: 'user/message',
            seq: 0,
            time: 1790920000100,
            data: {
              role: 'user',
              source: { kind: 'user' },
              content: [{ type: 'text', text: 'Continue DSH work' }]
            }
          }
        ])
      )
    )
    memory.addFile(dshPath, 'binary placeholder', 10)
    memory.addFile(
      idePath,
      jsonLines([
        {
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          created_at: '2026-10-02T01:00:00Z',
          content: '<USER_REQUEST>Continue IDE work</USER_REQUEST>'
        }
      ]),
      11
    )
    const reads: string[] = []
    const provider: RemoteSessionFilesystemProvider = {
      readDir: (path) => memory.readDir(path),
      stat: (path) => memory.stat(path),
      readFile: (path) => memory.readFile(path),
      readTranscriptBytes: async function* (path, _signal, options) {
        reads.push(path)
        if (path === dshPath) {
          expect(options).toBe('dsh-zstd')
          yield compressed
        } else {
          expect(options).toMatchObject({ regularFileOnly: true })
          yield Buffer.from((await memory.readFile(path)).content)
        }
      }
    }
    const args = {
      provider,
      remoteHome,
      hostPlatform,
      dshSessionsDir,
      executionHostId: 'ssh:combined-host' as const
    }
    const combined = await scanRemoteAiVaultSessions({
      ...args,
      includeAntigravityIdeSessions: true
    })
    expect(combined.issues).toEqual([])
    expect(combined.sessions.map((session) => session.agent).sort()).toEqual(['antigravity', 'dsh'])
    expect(
      combined.sessions.every((session) => session.executionHostId === args.executionHostId)
    ).toBe(true)
    expect(combined.sessions.find((session) => session.agent === 'dsh')?.resumeCommand).toContain(
      "DSH_HOME='/host/custom-dsh'"
    )
    expect(reads).toContain(dshPath)
    expect(memory.readDirPaths.every((path) => path.startsWith('/host/'))).toBe(true)
    const legacy = await scanRemoteAiVaultSessions(args)
    expect(legacy.sessions.map((session) => session.agent)).toEqual(['dsh'])
  })
})
