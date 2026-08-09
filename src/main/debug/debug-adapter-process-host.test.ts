import { describe, expect, it } from 'vitest'
import { LocalDebugAdapterProcessHost, resolveSpawnTarget } from './debug-adapter-process-host'

const ECHO_SCRIPT = 'process.stdin.on("data", (d) => process.stdout.write(d))'

describe('LocalDebugAdapterProcessHost', () => {
  it('spawns a process and streams stdout back for data written to stdin', async () => {
    const host = new LocalDebugAdapterProcessHost()
    const proc = await host.spawn({
      type: 'node',
      request: 'launch',
      command: process.execPath,
      args: ['-e', ECHO_SCRIPT]
    })

    const received = new Promise<string>((resolve) => {
      let buffer = ''
      proc.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        if (buffer.includes('ping')) {
          resolve(buffer)
        }
      })
    })
    proc.stdin.write('ping')

    await expect(received).resolves.toContain('ping')
    proc.kill()
  })

  it('kill() terminates the spawned process', async () => {
    const host = new LocalDebugAdapterProcessHost()
    const proc = await host.spawn({
      type: 'node',
      request: 'launch',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)']
    })

    const exited = new Promise<void>((resolve) => {
      proc.stdout.on('close', () => resolve())
    })
    proc.kill()
    await exited
  })

  it('rejects when the adapter command does not exist', async () => {
    const host = new LocalDebugAdapterProcessHost()
    await expect(
      host.spawn({
        type: 'node',
        request: 'launch',
        command: 'orca-debug-adapter-that-does-not-exist',
        args: []
      })
    ).rejects.toThrow()
  })
})

describe('resolveSpawnTarget', () => {
  const config = {
    type: 'node' as const,
    request: 'launch' as const,
    command: 'node',
    args: ['server.js'],
    cwd: '/mnt/wsl/project',
    env: { NODE_ENV: 'production' }
  }

  it('passes the config through unchanged when no WSL distro is set', () => {
    expect(resolveSpawnTarget(config, undefined)).toEqual(config)
  })

  it('wraps the command through wsl.exe when a distro is set, folding cwd/env into the posix line', () => {
    const target = resolveSpawnTarget(config, 'Ubuntu')
    expect(target.command).toBe('wsl.exe')
    expect(target.args.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--', 'bash', '-lc'])
    expect(target.cwd).toBeUndefined()
    expect(target.env).toBeUndefined()

    const decoded = Buffer.from(
      target.args[5]!.match(/printf %s '([^']+)'/)?.[1] ?? '',
      'base64'
    ).toString('utf8')
    expect(decoded).toBe("cd '/mnt/wsl/project' && NODE_ENV='production' exec 'node' 'server.js'")
  })
})
