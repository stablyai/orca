import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { MemoryRemoteProvider, jsonLines } from './remote-session-scanner-test-fixtures'

const home = '/home/ada'
const legacy = `${home}/.omp/agent/sessions`
const relocated = '/data/omp/profiles/work/sessions'
const platform = getRemoteHostPlatform('linux-x64')

function fixture() {
  const provider = new MemoryRemoteProvider()
  for (const [root, id] of [
    [legacy, 'legacy'],
    [relocated, 'relocated']
  ]) {
    provider.addFile(
      `${root}/folder/${id}.jsonl`,
      jsonLines([
        { type: 'session', id, cwd: '/folder workspace', timestamp: '2026-09-14T10:00:00Z' },
        { type: 'message', message: { role: 'user', content: id } }
      ]),
      70
    )
  }
  return provider
}

afterEach(() => vi.unstubAllEnvs())

describe('host-resolved OMP remote scan roots', () => {
  it('scans the host-selected root once instead of the coexisting legacy store', async () => {
    const provider = fixture()
    const result = await scanRemoteAiVaultSessions({
      provider,
      remoteHome: home,
      hostPlatform: platform,
      executionHostId: 'ssh:box',
      ompSessionsDir: relocated
    })
    expect(result.sessions.map((row) => row.sessionId)).toEqual(['relocated'])
    expect(result.sessions[0]?.executionHostId).toBe('ssh:box')
    expect(provider.readDirPaths.filter((path) => path === relocated)).toHaveLength(1)
    expect(provider.readDirPaths).not.toContain(legacy)
  })

  it('does not fall back when the host refuses an unsafe root', async () => {
    const provider = fixture()
    const result = await scanRemoteAiVaultSessions({
      provider,
      remoteHome: home,
      hostPlatform: platform,
      executionHostId: 'ssh:box',
      ompSessionsDir: ''
    })
    expect(result.sessions).toEqual([])
    expect(provider.readDirPaths).not.toContain(legacy)
    expect(provider.readDirPaths).not.toContain('')
  })

  it('uses a Windows host root verbatim on a different client platform', async () => {
    const provider = new MemoryRemoteProvider()
    const root = 'D:\\OMP data\\profiles\\work\\sessions'
    const file = `${root}\\folder\\session.jsonl`
    provider.addFile(
      file,
      jsonLines([
        {
          type: 'session',
          id: 'windows',
          cwd: 'D:\\folder workspace',
          timestamp: '2026-09-14T10:00:00Z'
        },
        { type: 'message', message: { role: 'user', content: 'Windows host' } }
      ]),
      80
    )
    const result = await scanRemoteAiVaultSessions({
      provider,
      remoteHome: 'C:\\Users\\ada',
      hostPlatform: getRemoteHostPlatform('win32-x64'),
      executionHostId: 'ssh:windows',
      ompSessionsDir: root
    })
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      sessionId: 'windows',
      executionHostId: 'ssh:windows',
      executionHostPlatform: 'win32',
      cwd: 'D:\\folder workspace'
    })
    expect(provider.readDirPaths).toContain(root.replaceAll('\\', '/'))
  })

  it('keeps legacy fallback scans independent of the client environment', async () => {
    vi.stubEnv('OMP_CODING_AGENT_DIR', relocated)
    vi.stubEnv('OMP_PROFILE', 'work')
    const result = await scanRemoteAiVaultSessions({
      provider: fixture(),
      remoteHome: home,
      hostPlatform: platform,
      executionHostId: 'ssh:box'
    })
    expect(result.sessions.map((row) => row.sessionId)).toEqual(['legacy'])
  })
})
