import { describe, expect, it, vi } from 'vitest'
import type { SFTPWrapper } from 'ssh2'
import { CodexHookService } from './hook-service'
import { upsertHookTrustEntriesInContent } from './config-toml-trust'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-user-data'
  }
}))

function createFakeSftp(initialFiles: Record<string, string> = {}): {
  sftp: SFTPWrapper
  files: Map<string, string>
} {
  const files = new Map(Object.entries(initialFiles))
  const dirs = new Set(['/'])
  const noEntry = (path: string): { code: number; message: string } => ({
    code: 2,
    message: `ENOENT ${path}`
  })
  const sftp = {
    readFile: (path: string, _enc: string, cb: (err: unknown, data?: string) => void): void => {
      const value = files.get(path)
      if (value === undefined) {
        cb(noEntry(path))
        return
      }
      cb(null, value)
    },
    writeFile: (
      path: string,
      content: string,
      _options: string | { mode?: number },
      cb: (err: unknown) => void
    ): void => {
      files.set(path, content)
      cb(null)
    },
    rename: (src: string, dst: string, cb: (err: unknown) => void): void => {
      const value = files.get(src)
      if (value === undefined) {
        cb(noEntry(src))
        return
      }
      files.set(dst, value)
      files.delete(src)
      cb(null)
    },
    unlink: (path: string, cb: (err: unknown) => void): void => {
      files.delete(path)
      cb(null)
    },
    chmod: (_path: string, _mode: number, cb: (err: unknown) => void): void => {
      cb(null)
    },
    stat: (path: string, cb: (err: unknown, stats?: { mode: number }) => void): void => {
      if (!files.has(path)) {
        cb(noEntry(path))
        return
      }
      cb(null, { mode: 0o100644 })
    },
    readdir: (path: string, cb: (err: unknown, list?: { filename: string }[]) => void): void => {
      if (!dirs.has(path)) {
        cb(noEntry(path))
        return
      }
      cb(null, [])
    },
    mkdir: (path: string, cb: (err: unknown) => void): void => {
      dirs.add(path)
      cb(null)
    }
  } as unknown as SFTPWrapper
  return { sftp, files }
}

function hookTrustBlock(content: string, key: string): string {
  const header = `[hooks.state."${key}"]`
  const start = content.indexOf(header)
  if (start === -1) {
    return ''
  }
  const nextHeader = content.indexOf('\n[', start + header.length)
  return content.slice(start, nextHeader === -1 ? content.length : nextHeader)
}

describe('Codex remote hook prepend + trust migration', () => {
  it('prepends remote hooks without invalidating existing user hook trust', async () => {
    const remoteHooksPath = '/home/dev/.codex/hooks.json'
    const userStopCommand = 'echo user-stop-hook'
    const userTrustedHash = 'sha256:user-approved-stop-hook'
    const { sftp, files } = createFakeSftp({
      [remoteHooksPath]: `${JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: 'command', command: userStopCommand }] }]
        }
      })}\n`,
      '/home/dev/.codex/config.toml': upsertHookTrustEntriesInContent('', [
        {
          sourcePath: remoteHooksPath,
          eventLabel: 'stop',
          groupIndex: 0,
          handlerIndex: 0,
          command: userStopCommand,
          trustedHash: userTrustedHash,
          enabled: false
        }
      ])
    })

    const service = new CodexHookService()
    const status = await service.installRemote(sftp, '/home/dev')
    const repeatedStatus = await service.installRemote(sftp, '/home/dev')

    expect(status.state).toBe('installed')
    expect(repeatedStatus.state).toBe('installed')
    const hooks = JSON.parse(files.get(remoteHooksPath)!) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
    }
    expect(hooks.hooks.Stop?.[0]?.hooks?.[0]?.command).toContain('codex-hook.sh')
    expect(hooks.hooks.Stop?.[1]?.hooks?.[0]?.command).toBe(userStopCommand)
    expect(hooks.hooks.SubagentStart?.[0]?.hooks?.[0]?.command).toContain('codex-hook.sh')
    expect(hooks.hooks.SubagentStop?.[0]?.hooks?.[0]?.command).toContain('codex-hook.sh')
    const toml = files.get('/home/dev/.codex/config.toml') ?? ''
    expect(toml).toContain(':stop:0:0')
    expect(toml).toContain(':subagent_start:0:0')
    expect(toml).toContain(':subagent_stop:0:0')
    const userStopTrust = hookTrustBlock(toml, `${remoteHooksPath}:stop:1:0`)
    expect(userStopTrust).toContain('enabled = false')
    expect(userStopTrust).toContain(`trusted_hash = "${userTrustedHash}"`)
    expect(hookTrustBlock(toml, `${remoteHooksPath}:stop:0:0`)).not.toContain(userTrustedHash)
    expect(toml).not.toContain(`${remoteHooksPath}:stop:2:0`)
  })

  it('moves a disabled no-hash user hook on SSH and WSL-redirected prepend, including repeats', async () => {
    const posixHooksPath = '/home/dev/.codex/hooks.json'
    const wslHooksPath = '/mnt/c/Users/me/.codex/hooks.json'
    const userA = 'echo user-stop-a'
    const userB = 'echo user-stop-b'
    const userBHash = 'sha256:user-b'
    const seedToml = (hooksPath: string) =>
      [
        `[hooks.state."${hooksPath}:stop:0:0"]`,
        'enabled = false',
        '',
        `[hooks.state."${hooksPath}:stop:1:0"]`,
        'enabled = false',
        `trusted_hash = "${userBHash}"`,
        ''
      ].join('\n')
    const hooksJson = `${JSON.stringify({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: userA }] },
          { hooks: [{ type: 'command', command: userB }] }
        ]
      }
    })}\n`

    const { sftp: sshSftp, files: sshFiles } = createFakeSftp({
      [posixHooksPath]: hooksJson,
      '/home/dev/.codex/config.toml': seedToml(posixHooksPath)
    })
    const { sftp: wslSftp, files: wslFiles } = createFakeSftp({
      [wslHooksPath]: hooksJson,
      '/mnt/c/Users/me/.codex/config.toml': seedToml(wslHooksPath)
    })

    const service = new CodexHookService()
    const sshFirst = await service.installRemote(sshSftp, '/home/dev')
    const sshRepeat = await service.installRemote(sshSftp, '/home/dev')
    const wslFirst = await service.installRemote(wslSftp, '/home/dev', {
      codexHomeDir: '/mnt/c/Users/me/.codex'
    })
    const wslRepeat = await service.installRemote(wslSftp, '/home/dev', {
      codexHomeDir: '/mnt/c/Users/me/.codex'
    })

    expect(sshFirst.state).toBe('installed')
    expect(sshRepeat.state).toBe('installed')
    expect(wslFirst.state).toBe('installed')
    expect(wslRepeat.state).toBe('installed')

    for (const [hooksPath, files, tomlPath] of [
      [posixHooksPath, sshFiles, '/home/dev/.codex/config.toml'],
      [wslHooksPath, wslFiles, '/mnt/c/Users/me/.codex/config.toml']
    ] as const) {
      const hooks = JSON.parse(files.get(hooksPath)!) as {
        hooks: Record<string, { hooks?: { command?: string }[] }[]>
      }
      expect(hooks.hooks.Stop?.[0]?.hooks?.[0]?.command).toContain('codex-hook.sh')
      expect(hooks.hooks.Stop?.[1]?.hooks?.[0]?.command).toBe(userA)
      expect(hooks.hooks.Stop?.[2]?.hooks?.[0]?.command).toBe(userB)
      const toml = files.get(tomlPath) ?? ''
      const movedA = hookTrustBlock(toml, `${hooksPath}:stop:1:0`)
      const movedB = hookTrustBlock(toml, `${hooksPath}:stop:2:0`)
      expect(movedA).toContain('enabled = false')
      expect(movedA).not.toContain('trusted_hash')
      expect(movedB).toContain('enabled = false')
      expect(movedB).toContain(`trusted_hash = "${userBHash}"`)
      expect(hookTrustBlock(toml, `${hooksPath}:stop:0:0`)).not.toContain(userBHash)
      expect(toml).not.toContain(`${hooksPath}:stop:3:0`)
    }
  })
})
