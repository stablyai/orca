import { mkdtemp, mkdir, rm, writeFile, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentProfileConnectionService } from './connection-service'
import { createClaudeProfileAdapter, createCodexProfileAdapter } from './provider-adapters'

describe('explicit command home resolution', () => {
  let root: string
  let home: string
  let canonicalExecutable: string
  let detectedExecutable: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'profile-command-'))
    home = join(root, 'account')
    await mkdir(home)
    canonicalExecutable = join(root, 'versioned-cli')
    await writeFile(canonicalExecutable, 'synthetic executable')
    await chmod(canonicalExecutable, 0o700)
    detectedExecutable = canonicalExecutable
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })
  function service(content = `alias work='CLAUDE_CONFIG_DIR="${home}" claude'`) {
    const callbacks = { inspectManaged: vi.fn(), prepareManaged: vi.fn() }
    return new AgentProfileConnectionService({
      host: { hostId: 'local', platform: 'linux', isWsl: false, home: root, shell: '/bin/bash' },
      adapters: {
        claude: createClaudeProfileAdapter(callbacks),
        codex: createCodexProfileAdapter(callbacks)
      },
      detectExecutable: async () => detectedExecutable,
      readAliases: async () => [{ name: '.bash_aliases', content }],
      store: { read: () => [], write: vi.fn() }
    })
  }
  it.skipIf(process.platform === 'win32')(
    'resolves explicit assignment with trusted detected symlink and pins its canonical target',
    async () => {
      detectedExecutable = join(root, 'claude')
      await symlink(canonicalExecutable, detectedExecutable)
      const candidate = await service().preview({
        agent: 'claude',
        source: { kind: 'command', value: `CLAUDE_CONFIG_DIR="${home}" "${detectedExecutable}"` }
      })
      expect(candidate.executable).toBe(canonicalExecutable)
      expect(candidate.resolvedHome).toBe(home)
    }
  )
  it.skipIf(process.platform === 'win32')(
    'accepts explicit home assignment with the trusted canonical executable',
    async () => {
      const candidate = await service().preview({
        agent: 'claude',
        source: { kind: 'command', value: `CLAUDE_CONFIG_DIR="${home}" "${canonicalExecutable}"` }
      })
      expect(candidate.executable).toBe(canonicalExecutable)
      expect(candidate.resolvedHome).toBe(home)
    }
  )
  it('resolves a leading home tilde in folder selection', async () => {
    expect(
      (await service().preview({ agent: 'claude', source: { kind: 'home', value: '~/account' } }))
        .resolvedHome
    ).toBe(home)
  })
  it('requires folder selection for every command without an explicit home, including a shadowed CLI', async () => {
    await mkdir(join(root, '.claude'))
    const svc = service(`alias claude='CLAUDE_CONFIG_DIR="${home}" claude'`)
    for (const value of ['claude', detectedExecutable, canonicalExecutable]) {
      await expect(
        svc.preview({ agent: 'claude', source: { kind: 'command', value } })
      ).rejects.toThrow(/folder/i)
    }
  })
  it.skipIf(process.platform === 'win32')(
    'resolves literal aliases and explicit assignments',
    async () => {
      const svc = service()
      for (const value of ['work', `CLAUDE_CONFIG_DIR="${home}" claude`]) {
        expect(
          (await svc.preview({ agent: 'claude', source: { kind: 'command', value } })).resolvedHome
        ).toBe(home)
      }
      await expect(
        svc.preview({ agent: 'claude', source: { kind: 'command', value: 'claude --resume' } })
      ).rejects.toThrow(/folder/i)
    }
  )
})
