import { mkdtemp, mkdir, rm, writeFile, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CODEX_PROFILE_ROUTING_ENV } from '../codex-accounts/profile-launch-authority'
import { AgentProfileConnectionService } from './connection-service'
import { prepareAgentProfileTerminalCommand } from './terminal-command'
import { runProcess } from '../../shared/child-process/run-process'
import { createClaudeProfileAdapter, createCodexProfileAdapter } from './provider-adapters'
import type {
  AgentLaunchProfile,
  ProfileAgent,
  ProfileIdentity
} from '../../shared/agent-launch-profile'

describe('host profile connections', () => {
  let root: string
  let home: string
  let executable: string
  let profiles: AgentLaunchProfile[]
  let identity: ProfileIdentity
  const inspectManaged = vi.fn()
  const prepareManaged = vi.fn()
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'profile-service-'))
    home = join(root, 'account')
    executable = join(root, 'cli')
    await mkdir(home)
    await writeFile(executable, 'synthetic executable')
    await chmod(executable, 0o700)
    profiles = []
    identity = { kind: 'verified', subject: 'one', displayName: 'One' }
    inspectManaged.mockReset().mockImplementation(async () => ({ home, identity }))
    prepareManaged
      .mockReset()
      .mockImplementation(async () => ({ home, envPatch: {}, envToDelete: [], release: vi.fn() }))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })
  function service(overrides = {}) {
    const callbacks = { inspectManaged, prepareManaged }
    return new AgentProfileConnectionService({
      host: { hostId: 'local', platform: 'linux', isWsl: false, home: root, shell: '/bin/bash' },
      adapters: {
        claude: createClaudeProfileAdapter(callbacks),
        codex: createCodexProfileAdapter(callbacks)
      },
      detectExecutable: async () => executable,
      inspectExternal: async () => identity,
      store: {
        read: () => profiles,
        write: async (value) => {
          profiles = value
        }
      },
      ...overrides
    })
  }
  function connection(agent: ProfileAgent = 'claude') {
    return { agent, source: { kind: 'home' as const, value: home } }
  }
  it.each(['claude', 'codex'] as const)(
    'external %s lifecycle never calls managed services',
    async (agent) => {
      const svc = service()
      const preview = await svc.preview(connection(agent))
      expect(preview.binding).toEqual({ kind: 'external', home })
      const saved = await svc.save({ name: 'Work', connection: connection(agent) })
      const prepared = await svc.prepare(saved, { resume: false, mode: 'terminal' })
      expect(prepared.envPatch[agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']).toBe(home)
      expect(prepared.envToDelete).toEqual([])
      await svc.unlink(saved.id)
      await expect(
        svc.prepare(prepared.snapshot, { resume: true, mode: 'structured' })
      ).resolves.toBeDefined()
      expect(inspectManaged).not.toHaveBeenCalled()
      expect(prepareManaged).not.toHaveBeenCalled()
    }
  )
  it.each(['claude', 'codex'] as const)(
    'retains an explicit custom %s home when Claude default and inherited homes exist',
    async (agent) => {
      await mkdir(join(root, '.claude'))
      vi.stubEnv('CLAUDE_CONFIG_DIR', home)
      try {
        const svc = service()
        const saved = await svc.save({ name: 'Custom', connection: connection(agent) })
        const prepared = await svc.prepare(saved, { resume: false, mode: 'terminal' })
        expect(prepared.envPatch).toEqual({
          [agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: home
        })
        expect(prepared.envToDelete).toEqual([])
        expect(() =>
          prepareAgentProfileTerminalCommand(prepared, agent, { HOME: '/external' })
        ).not.toThrow()
      } finally {
        vi.unstubAllEnvs()
      }
    }
  )
  it.skipIf(process.platform === 'win32')(
    'keeps a custom home ending in a space distinct from the default',
    async () => {
      await mkdir(join(root, '.claude'))
      home = join(root, '.claude ')
      await mkdir(home)
      const svc = service()
      const saved = await svc.save({ name: 'Literal path', connection: connection() })
      const prepared = await svc.prepare(saved, { resume: false, mode: 'terminal' })
      expect(prepared.snapshot.resolvedHome).toBe(home)
      expect(prepared.envPatch).toEqual({ CLAUDE_CONFIG_DIR: home })
      expect(prepared.envToDelete).toEqual([])
    }
  )
  it.each(['linux', 'darwin'] as const)(
    'preserves external Claude default credentials on %s despite inherited overrides',
    async (platform) => {
      home = join(root, '.claude')
      await mkdir(home)
      vi.stubEnv('CLAUDE_CONFIG_DIR', '/inherited/other')
      try {
        const svc = service({
          host: { hostId: 'local', platform, isWsl: false, home: root, shell: '/bin/sh' }
        })
        const saved = await svc.save({ name: 'Default home', connection: connection() })
        const prepared = await svc.prepare(saved, { resume: false, mode: 'terminal' })
        expect(prepared.snapshot.resolvedHome).toBe(home)
        expect(prepared.snapshot.binding).toEqual({ kind: 'external', home })
        expect(prepared.envPatch).toEqual({ HOME: root })
        expect(prepared.envToDelete).toEqual(['CLAUDE_CONFIG_DIR'])
        const { command } = prepareAgentProfileTerminalCommand(prepared, 'claude')
        expect(command).toContain("'-u' 'CLAUDE_CONFIG_DIR'")
        expect(command).not.toContain('CLAUDE_CONFIG_DIR=')
        expect(() =>
          prepareAgentProfileTerminalCommand(prepared, 'claude', { HOME: '/wrong' })
        ).toThrow(/override/)
      } finally {
        vi.unstubAllEnvs()
      }
    }
  )
  it.skipIf(process.platform === 'win32')(
    'keeps the canonical default home bound after shell startup exports',
    async () => {
      await symlink(home, join(root, '.claude'))
      const svc = service()
      const saved = await svc.save({ name: 'Linked default', connection: connection() })
      const prepared = await svc.prepare(saved, { resume: false, mode: 'terminal' })
      expect(prepared.snapshot.resolvedHome).toBe(home)
      expect(prepared.envPatch).toEqual({ HOME: root })
      prepared.snapshot.executable = '/usr/bin/env'
      const { command } = prepareAgentProfileTerminalCommand(prepared, 'claude')
      const result = await runProcess({
        program: '/bin/sh',
        args: [
          '-c',
          `export HOME=/wrong CLAUDE_CONFIG_DIR=/wrong ANTHROPIC_API_KEY=external; ${command}`
        ]
      })
      expect(result.code).toBe(0)
      expect(result.stdout).not.toContain('CLAUDE_CONFIG_DIR=')
      expect(result.stdout).toContain('ANTHROPIC_API_KEY=external')
      expect(result.stdout.split('\n')).toContain(`HOME=${root}`)
    }
  )
  it.each(['claude', 'codex'] as const)(
    'managed %s delegates preparation by account',
    async (agent) => {
      const svc = service()
      const profile = await svc.save({
        name: 'Work',
        connection: { agent, source: { kind: 'managed', accountId: 'account' } }
      })
      await svc.prepare(profile, { resume: true, mode: 'structured' })
      expect(prepareManaged).toHaveBeenCalledWith('account', expect.anything())
    }
  )
  it.skipIf(process.platform === 'win32')(
    'composes managed Codex deletions after shell exports while retaining external configuration',
    async () => {
      // A synthetic provider ignores Codex argv and reports only its final environment.
      await writeFile(executable, '#!/bin/sh\n/usr/bin/env\n')
      const svc = service()
      const managed = await svc.save({
        name: 'Managed',
        connection: { agent: 'codex', source: { kind: 'managed', accountId: 'account' } }
      })
      const external = await svc.save({ name: 'External', connection: connection('codex') })
      for (const profile of [managed, external]) {
        const prepared = await svc.prepare(profile, { resume: false, mode: 'terminal' })
        const isManaged = profile.binding.kind === 'managed'
        expect(prepared.envToDelete).toEqual(
          isManaged ? ['OPENAI_API_KEY', 'CODEX_API_KEY', ...CODEX_PROFILE_ROUTING_ENV] : []
        )
        const { command } = prepareAgentProfileTerminalCommand(prepared, 'codex')
        const result = await runProcess({
          program: '/bin/sh',
          args: [
            '-c',
            `export OPENAI_API_KEY=synthetic-openai CODEX_API_KEY=synthetic-codex OPENAI_BASE_URL=https://synthetic.invalid CODEX_HOME=/wrong PROFILE_SENTINEL=keep; ${command}`
          ]
        })
        expect(result.code).toBe(0)
        const env = result.stdout.split('\n')
        expect(env).toContain(`CODEX_HOME=${home}`)
        expect(env).toContain('PROFILE_SENTINEL=keep')
        for (const entry of [
          'OPENAI_API_KEY=synthetic-openai',
          'CODEX_API_KEY=synthetic-codex',
          'OPENAI_BASE_URL=https://synthetic.invalid'
        ]) {
          expect(env.includes(entry)).toBe(!isManaged)
        }
        prepared.release()
      }
      expect(prepareManaged).toHaveBeenCalledOnce()
    }
  )
  it('revalidates saves and missing homes', async () => {
    const svc = service()
    await svc.preview(connection())
    await rm(home, { recursive: true })
    await expect(svc.save({ name: 'Work', connection: connection() })).rejects.toThrow(/home/i)
    expect(profiles).toHaveLength(0)
  })
  it('serializes writes, rejects duplicate bindings, renames and rejects unknown ids', async () => {
    const second = join(root, 'second')
    await mkdir(second)
    const svc = service()
    await Promise.all([
      svc.save({ name: 'One', connection: connection() }),
      svc.save({
        name: 'Two',
        connection: { agent: 'codex', source: { kind: 'home', value: second } }
      })
    ])
    expect(profiles).toHaveLength(2)
    await expect(svc.save({ name: 'Other', connection: connection() })).rejects.toThrow(
      /already connected/i
    )
    const first = profiles[0]
    await svc.save({ id: first.id, name: 'Renamed', connection: connection() })
    expect(profiles[0].name).toBe('Renamed')
    await expect(
      svc.save({ id: 'missing', name: 'Missing', connection: connection() })
    ).rejects.toThrow(/no longer exists/i)
  })
  it('snapshots survive edits and refuse identity changes', async () => {
    const svc = service()
    const saved = await svc.save({ name: 'Work', connection: connection() })
    const { snapshot } = await svc.prepare(saved, { resume: false, mode: 'terminal' })
    const other = join(root, 'other')
    await mkdir(other)
    await svc.save({
      id: saved.id,
      name: 'Other',
      connection: { agent: 'claude', source: { kind: 'home', value: other } }
    })
    expect(
      (await svc.prepare(snapshot, { resume: true, mode: 'terminal' })).snapshot.resolvedHome
    ).toBe(home)
    identity = { kind: 'verified', subject: 'two', displayName: 'Two' }
    await expect(svc.prepare(snapshot, { resume: true, mode: 'terminal' })).rejects.toThrow(
      /identity/i
    )
  })
  it.skipIf(process.platform === 'win32')(
    'refuses a snapshot home replaced with a symlink',
    async () => {
      const svc = service()
      const saved = await svc.save({ name: 'Work', connection: connection() })
      const { snapshot } = await svc.prepare(saved, { resume: false, mode: 'terminal' })
      const other = join(root, 'other')
      await mkdir(other)
      await rm(home, { recursive: true })
      await symlink(other, home)
      await expect(svc.prepare(snapshot, { resume: false, mode: 'terminal' })).rejects.toThrow(
        /home.*changed/i
      )
    }
  )
  it('unverified identity permits fresh terminal only', async () => {
    identity = { kind: 'unverified', reason: 'unsupported' }
    const svc = service()
    const saved = await svc.save({ name: 'Work', connection: connection() })
    await expect(svc.prepare(saved, { resume: false, mode: 'terminal' })).resolves.toBeDefined()
    await expect(svc.prepare(saved, { resume: true, mode: 'terminal' })).rejects.toThrow(
      /unverified/i
    )
    await expect(svc.prepare(saved, { resume: false, mode: 'structured' })).rejects.toThrow(
      /unverified/i
    )
  })
  it.each([{ platform: 'win32' }, { isWsl: true }, { hostId: 'ssh:remote' }])(
    'guards host before side effects %j',
    async (change) => {
      const detector = vi.fn()
      const svc = service({
        host: {
          hostId: 'local',
          platform: 'linux',
          isWsl: false,
          home: root,
          shell: '/bin/bash',
          ...change
        },
        detectExecutable: detector
      })
      await expect(svc.preview(connection())).rejects.toThrow(/supported/i)
      expect(detector).not.toHaveBeenCalled()
      expect(inspectManaged).not.toHaveBeenCalled()
    }
  )
  it('rejects reserved names, name collisions and count overflow', async () => {
    const svc = service()
    await expect(svc.save({ name: 'Claude', connection: connection() })).rejects.toThrow(/built-in/)
    const first = await svc.save({ name: 'Work', connection: connection() })
    await expect(svc.save({ name: ' work ', connection: connection('codex') })).rejects.toThrow(
      /name/
    )
    profiles = Array.from({ length: 32 }, (_, index) => ({
      ...first,
      id: `id${index}`,
      name: `Name ${index}`
    }))
    await expect(svc.save({ name: 'Overflow', connection: connection() })).rejects.toThrow(/32/)
  })
  it('pins discovered updates without changing saved ownership', async () => {
    const svc = service()
    const profile = await svc.save({ name: 'Work', connection: connection() })
    const beforeUpdate = await svc.resolveSnapshotById(profile.id, {
      resume: false,
      mode: 'structured'
    })
    const changed = join(root, 'other-cli')
    await writeFile(changed, 'fake')
    await chmod(changed, 0o700)
    executable = changed
    await expect(
      svc.save({ name: 'Duplicate after update', connection: connection() })
    ).rejects.toThrow(/already connected/i)
    await svc.resolveSnapshotById(profile.id, { resume: false, mode: 'structured' })
    expect(prepareManaged).not.toHaveBeenCalled()
    const acquired = await svc.prepare(beforeUpdate, { resume: true, mode: 'structured' })
    expect(acquired.snapshot.executable).toBe(changed)
    expect(profile.executable).not.toBe(changed)
  })
  it.skipIf(process.platform === 'win32')('refuses a nonexecutable detected file', async () => {
    await chmod(executable, 0o600)
    await expect(service().preview(connection())).rejects.toThrow(/unavailable/)
  })
  it.each(['missing', 'directory'])(
    'refuses a %s detected executable on every platform',
    async (kind) => {
      executable = kind === 'missing' ? join(root, 'missing-cli') : home
      await expect(service().preview(connection())).rejects.toThrow(/unavailable/)
    }
  )
  it('releases managed preparation if the provider changes its home', async () => {
    const svc = service()
    const profile = await svc.save({
      name: 'Managed',
      connection: { agent: 'codex', source: { kind: 'managed', accountId: 'one' } }
    })
    const release = vi.fn()
    const other = join(root, 'other')
    await mkdir(other)
    prepareManaged.mockResolvedValue({ home: other, envPatch: {}, envToDelete: [], release })
    await expect(svc.prepare(profile, { resume: false, mode: 'terminal' })).rejects.toThrow(
      /home changed/
    )
    expect(release).toHaveBeenCalledOnce()
  })
  it('preserves existing credentials and only persists contract fields', async () => {
    const marker = join(home, 'credentials')
    await writeFile(marker, 'synthetic credential marker')
    const svc = service()
    const profile = await svc.save({ name: 'Work', connection: connection() })
    expect(Object.keys(profile).sort()).toEqual([
      'agent',
      'binding',
      'executable',
      'hostId',
      'id',
      'name'
    ])
    await svc.unlink(profile.id)
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(marker, 'utf8')).toBe('synthetic credential marker')
  })
  it('does not expose provider error contents from managed inspection', async () => {
    inspectManaged.mockRejectedValue(new Error('synthetic secret-token-value'))
    await expect(
      service().preview({ agent: 'claude', source: { kind: 'managed', accountId: 'one' } })
    ).rejects.toThrow('Managed account inspection failed.')
  })
  it('does not upgrade an unverified snapshot into identity-bound acquisition', async () => {
    identity = { kind: 'unverified', reason: 'unsupported' }
    const svc = service()
    const profile = await svc.save({ name: 'Work', connection: connection() })
    const { snapshot } = await svc.prepare(profile, { resume: false, mode: 'terminal' })
    identity = { kind: 'verified', subject: 'later', displayName: 'Later' }
    await expect(svc.prepare(snapshot, { resume: true, mode: 'terminal' })).rejects.toThrow(
      /unverified/i
    )
    await expect(svc.prepare(snapshot, { resume: false, mode: 'structured' })).rejects.toThrow(
      /unverified/i
    )
    await expect(svc.prepare(snapshot, { resume: false, mode: 'terminal' })).resolves.toBeDefined()
  })
})
