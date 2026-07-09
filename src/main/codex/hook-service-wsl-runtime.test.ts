import { describe, expect, it } from 'vitest'
import type { SFTPWrapper } from 'ssh2'
import { win32 as pathWin32 } from 'node:path'

import { CodexHookService, createCodexWslRuntimeHookInstallPlan } from './hook-service'

type FakeFs = {
  files: Map<string, string>
  modes: Map<string, number>
}

function createFakeSftp(): {
  sftp: SFTPWrapper
  fs: FakeFs
} {
  const fs: FakeFs = {
    files: new Map(),
    modes: new Map()
  }
  const noEntryError = (path: string): { code: number; message: string } => ({
    code: 2,
    message: `ENOENT ${path}`
  })

  const sftp = {
    readFile: (path: string, _enc: string, cb: (err: unknown, data?: string) => void): void => {
      const value = fs.files.get(path)
      if (value === undefined) {
        cb(noEntryError(path))
        return
      }
      cb(null, value)
    },
    writeFile: (
      path: string,
      content: string,
      options: string | { mode?: number },
      cb: (err: unknown) => void
    ): void => {
      fs.files.set(path, content)
      if (typeof options !== 'string' && options.mode !== undefined) {
        fs.modes.set(path, options.mode)
      }
      cb(null)
    },
    rename: (src: string, dst: string, cb: (err: unknown) => void): void => {
      const value = fs.files.get(src)
      if (value === undefined) {
        cb(noEntryError(src))
        return
      }
      fs.files.set(dst, value)
      fs.files.delete(src)
      const mode = fs.modes.get(src)
      if (mode !== undefined) {
        fs.modes.set(dst, mode)
        fs.modes.delete(src)
      }
      cb(null)
    },
    unlink: (path: string, cb: (err: unknown) => void): void => {
      fs.files.delete(path)
      fs.modes.delete(path)
      cb(null)
    },
    chmod: (path: string, mode: number, cb: (err: unknown) => void): void => {
      fs.modes.set(path, mode)
      cb(null)
    },
    stat: (path: string, cb: (err: unknown, stats?: { mode: number }) => void): void => {
      if (!fs.files.has(path)) {
        cb(noEntryError(path))
        return
      }
      cb(null, { mode: fs.modes.get(path) ?? 0o100644 })
    },
    readdir: (_path: string, cb: (err: unknown, list?: { filename: string }[]) => void): void => {
      cb(null, [])
    },
    mkdir: (_path: string, cb: (err: unknown) => void): void => {
      cb(null)
    }
  } as unknown as SFTPWrapper

  return { sftp, fs }
}

describe('Codex WSL runtime hook install', () => {
  it('plans WSL hook files with Linux command and trust paths', () => {
    const runtimeHome =
      '\\\\wsl.localhost\\Ubuntu\\home\\alice\\.local\\share\\orca\\codex-runtime-home\\home'

    expect(createCodexWslRuntimeHookInstallPlan(runtimeHome)).toEqual({
      configPath: pathWin32.join(runtimeHome, 'hooks.json'),
      tomlPath: pathWin32.join(runtimeHome, 'config.toml'),
      scriptPath: pathWin32.join(runtimeHome, '.orca', 'agent-hooks', 'codex-hook.sh'),
      commandScriptPath:
        '/home/alice/.local/share/orca/codex-runtime-home/home/.orca/agent-hooks/codex-hook.sh',
      trustConfigPath: '/home/alice/.local/share/orca/codex-runtime-home/home/hooks.json'
    })
  })

  it('generates a POSIX hook that bridges WSL loopback failures through Windows curl', async () => {
    const { sftp, fs } = createFakeSftp()

    await new CodexHookService().installRemote(sftp, '/home/dev')

    const script = fs.files.get('/home/dev/.orca/agent-hooks/codex-hook.sh')
    expect(script).toContain('post_codex_hook()')
    expect(script).toContain('is_wsl_runtime()')
    expect(script).toContain('WSL_DISTRO_NAME')
    expect(script).toContain('/mnt/c/Windows/System32/curl.exe')
    expect(script).toContain('--data-urlencode "payload@-"')
    expect(script).toContain('if post_codex_hook curl >/dev/null 2>&1; then')
    expect(script).toContain('post_codex_hook "$windows_curl" 3 5 >/dev/null 2>&1 || true')
  })
})
