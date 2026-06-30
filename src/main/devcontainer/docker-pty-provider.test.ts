import { describe, expect, it, vi } from 'vitest'

// node-pty ships a native binary that isn't built in this environment; the
// provider only needs the type at runtime via an injected spawn, so stub it.
vi.mock('node-pty', () => ({ spawn: vi.fn() }))

import { DockerPtyProvider, type DockerPtyProviderConfig } from './docker-pty-provider'

type FakePty = {
  pid: number
  process: string
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  onData: (cb: (data: string) => void) => void
  onExit: (cb: (e: { exitCode: number }) => void) => void
  emitData: (data: string) => void
  emitExit: (code: number) => void
}

/** A fake node-pty handle whose data/exit events can be driven from tests. */
function makeFakePty(): FakePty {
  let dataCb: ((data: string) => void) | null = null
  let exitCb: ((e: { exitCode: number }) => void) | null = null
  return {
    pid: 4242,
    process: 'docker',
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: (cb) => {
      dataCb = cb
    },
    onExit: (cb) => {
      exitCb = cb
    },
    emitData: (data) => dataCb?.(data),
    emitExit: (code) => exitCb?.({ exitCode: code })
  }
}

/** Construct a provider wired to a fake spawn + stub config for assertions. */
function setup(overrides: Partial<DockerPtyProviderConfig> = {}) {
  const fake = makeFakePty()
  const ptySpawn = vi.fn(() => fake as never)
  const provider = new DockerPtyProvider({
    resolveContainerId: async () => 'container-xyz',
    hostToContainerCwd: (hostPath) =>
      hostPath.replace('/Users/me/work/aprium', '/workspaces/aprium'),
    forwardEnv: ['ANTHROPIC_API_KEY'],
    resolveSpawnEnv: () => ({ ANTHROPIC_API_KEY: 'secret', PATH: '/usr/bin' }),
    ptySpawn,
    ...overrides
  })
  return { provider, ptySpawn, fake }
}

describe('DockerPtyProvider.spawn', () => {
  it('spawns docker exec with translated cwd, forwarded env, and TERM', async () => {
    const { provider, ptySpawn } = setup()
    const originalAnthropic = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'ambient-secret'
    try {
      const result = await provider.spawn({
        cols: 120,
        rows: 30,
        cwd: '/Users/me/work/aprium/.worktrees/feat',
        env: { TERM: 'xterm-kitty', ANTHROPIC_API_KEY: 'from-spawn-env', PATH: '/opt/bin' }
      })

      expect(result.pid).toBe(4242)
      expect(result.id).toMatch(/^dpty-\d+$/)

      const [file, args, options] = ptySpawn.mock.calls[0] as unknown as [
        string,
        string[],
        { env: Record<string, string>; cols: number }
      ]
      expect(file).toBe('docker')
      expect(args).toEqual([
        'exec',
        '-i',
        '-t',
        '-w',
        '/workspaces/aprium/.worktrees/feat',
        '-e',
        'ANTHROPIC_API_KEY',
        '-e',
        'TERM=xterm-kitty',
        'container-xyz',
        'bash'
      ])
      // Secret value travels via the spawn env, not the argv.
      expect(options.env.ANTHROPIC_API_KEY).toBe('from-spawn-env')
      expect(options.env.PATH).toBe('/opt/bin')
      expect(args.join(' ')).not.toContain('from-spawn-env')
      expect(args.join(' ')).not.toContain('ambient-secret')
    } finally {
      if (originalAnthropic !== undefined) {
        process.env.ANTHROPIC_API_KEY = originalAnthropic
      } else {
        delete process.env.ANTHROPIC_API_KEY
      }
    }
  })

  it('uses the configured spawn env resolver when opts.env is omitted', async () => {
    const { provider, ptySpawn } = setup({
      resolveSpawnEnv: () => ({ TERM: 'xterm-256color', ANTHROPIC_API_KEY: 'resolved-secret' })
    })

    await provider.spawn({ cols: 80, rows: 24, cwd: '/Users/me/work/aprium' })

    const [, , options] = ptySpawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string> }
    ]
    expect(options.env.ANTHROPIC_API_KEY).toBe('resolved-secret')
  })

  it('routes onData and cleans up on exit', async () => {
    const { provider, fake } = setup()
    const data = vi.fn()
    const exit = vi.fn()
    provider.onData(data)
    provider.onExit(exit)

    const { id } = await provider.spawn({ cols: 80, rows: 24, cwd: '/Users/me/work/aprium' })
    expect(provider.hasPty(id)).toBe(true)

    fake.emitData('hello')
    expect(data).toHaveBeenCalledWith({ id, data: 'hello' })

    fake.emitExit(0)
    expect(exit).toHaveBeenCalledWith({ id, code: 0 })
    expect(provider.hasPty(id)).toBe(false)
  })

  it('forwards write/resize/kill to the underlying pty', async () => {
    const { provider, fake } = setup()
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    provider.write(id, 'ls\n')
    provider.resize(id, 100, 40)
    await provider.shutdown(id, {})
    expect(fake.write).toHaveBeenCalledWith('ls\n')
    expect(fake.resize).toHaveBeenCalledWith(100, 40)
    expect(fake.kill).toHaveBeenCalled()
  })
})
