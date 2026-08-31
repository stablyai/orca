import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { isCodexManagedCommand, setupCodexHookHomes } from './hook-service-test-harness'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof Os>()
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { CodexHookService } from './hook-service'
import { runExclusivelyForCodexTrustConfig } from './codex-trust-config-mutation-queue'

const WINDOWS_POWERSHELL_LAUNCHER =
  /^[A-Za-z]:\/[^"]*\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoProfile -EncodedCommand \S+$/

const homes = setupCodexHookHomes(homedirMock, getPathMock)

function localManagedCodexEvents(): string[] {
  return [
    'PermissionRequest',
    'PostToolUse',
    'PreToolUse',
    'SessionStart',
    'Stop',
    'SubagentStart',
    'SubagentStop',
    'UserPromptSubmit'
  ]
}

describe('CodexHookService', () => {
  // Why (#16441): install promotes in-Orca approvals into ~/.codex/config.toml
  // and mirrors that file into the managed home, so holding only the runtime
  // lane still lets it land inside a real-home grant's capture->restore window.
  it('waits for an in-flight mutation of the system config.toml', async () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(join(systemCodexHome, 'config.toml'), 'approval_policy = "on-request"\n', 'utf-8')
    const managedHooksJsonPath = join(homes.userDataDir, 'codex-runtime-home', 'home', 'hooks.json')
    let releaseGrant!: () => void
    const grantHoldingSystemConfig = new Promise<void>((resolve) => {
      releaseGrant = resolve
    })
    const held = runExclusivelyForCodexTrustConfig(
      join(systemCodexHome, 'config.toml'),
      () => grantHoldingSystemConfig
    )

    const install = new CodexHookService().install()
    await new Promise((resolve) => setImmediate(resolve))
    expect(existsSync(managedHooksJsonPath)).toBe(false)

    releaseGrant()
    await held
    await expect(install).resolves.toMatchObject({ state: 'installed' })
    expect(existsSync(managedHooksJsonPath)).toBe(true)
  })

  it('makes the user-hook refresh wait for the system config.toml too', async () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(join(systemCodexHome, 'config.toml'), 'approval_policy = "on-request"\n', 'utf-8')
    const managedHooksJsonPath = join(homes.userDataDir, 'codex-runtime-home', 'home', 'hooks.json')
    let releaseGrant!: () => void
    const held = runExclusivelyForCodexTrustConfig(
      join(systemCodexHome, 'config.toml'),
      () =>
        new Promise<void>((resolve) => {
          releaseGrant = resolve
        })
    )

    const refresh = new CodexHookService().refreshRuntimeUserHooks()
    await new Promise((resolve) => setImmediate(resolve))
    expect(existsSync(managedHooksJsonPath)).toBe(false)

    releaseGrant()
    await held
    await refresh
    expect(existsSync(managedHooksJsonPath)).toBe(true)
  })

  it('installs PermissionRequest with trust so Codex approval prompts reach Orca', async () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      join(systemCodexHome, 'config.toml'),
      'model = "gpt-5.2-codex"\napproval_policy = "on-request"\n',
      'utf-8'
    )

    const status = await new CodexHookService().install()

    expect(status.state).toBe('installed')

    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    const hooksConfig = JSON.parse(readFileSync(join(managedCodexHome, 'hooks.json'), 'utf-8')) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
    }

    expect(Object.keys(hooksConfig.hooks).sort()).toEqual(localManagedCodexEvents())
    expect(
      isCodexManagedCommand(hooksConfig.hooks.PermissionRequest?.[0]?.hooks?.[0]?.command)
    ).toBe(true)

    const trustConfig = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(trustConfig).toContain('model = "gpt-5.2-codex"')
    expect(trustConfig).toContain('approval_policy = "on-request"')
    expect(trustConfig).toContain(':permission_request:0:0')
  })

  it('installs managed hooks + trust into a per-account self-contained home, not the shared mirror', async () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(join(systemCodexHome, 'config.toml'), 'approval_policy = "on-request"\n', 'utf-8')

    const perAccountHome = join(homes.userDataDir, 'codex-accounts', 'account-1', 'home')
    mkdirSync(perAccountHome, { recursive: true })
    writeFileSync(join(perAccountHome, '.orca-managed-home'), 'account-1\n', 'utf-8')

    const status = await new CodexHookService().install(perAccountHome)
    expect(status.state).toBe('installed')

    // Hooks + trust land in THIS account's home.
    const hooksConfig = JSON.parse(readFileSync(join(perAccountHome, 'hooks.json'), 'utf-8')) as {
      hooks: Record<string, unknown>
    }
    expect(Object.keys(hooksConfig.hooks).sort()).toEqual(localManagedCodexEvents())
    const trustConfig = readFileSync(join(perAccountHome, 'config.toml'), 'utf-8')
    expect(trustConfig).toContain('approval_policy = "on-request"')
    expect(trustConfig).toContain(':permission_request:0:0')

    // The shared runtime mirror is never touched by a per-account install.
    expect(existsSync(join(homes.userDataDir, 'codex-runtime-home', 'home', 'hooks.json'))).toBe(
      false
    )
    // ~/.codex is only read for canonical config, never mutated with hooks.
    expect(existsSync(join(systemCodexHome, 'hooks.json'))).toBe(false)
  })

  it('drops plugin manager metadata from runtime hooks.json during install', async () => {
    const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
    mkdirSync(managedCodexHome, { recursive: true })
    writeFileSync(
      join(managedCodexHome, 'hooks.json'),
      `${JSON.stringify({
        hooks: {},
        _managed: {
          'compound-engineering': {
            Stop: [0]
          }
        }
      })}\n`,
      'utf-8'
    )

    expect((await new CodexHookService().install()).state).toBe('installed')

    const hooksConfig = JSON.parse(readFileSync(join(managedCodexHome, 'hooks.json'), 'utf-8')) as {
      hooks: Record<string, unknown>
      _managed?: unknown
    }
    expect(hooksConfig._managed).toBeUndefined()
    expect(Object.keys(hooksConfig)).toEqual(['hooks'])
  })

  // Why: #6078 — a Windows user profile path like `C:\Users\Jane Doe` used to
  // be written verbatim as the hook command, so Codex split it at the space and
  // the hook exited with code 1. Keep spaced paths on the encoded launcher so
  // `cmd.exe /C` never sees the raw script path.
  it.skipIf(process.platform !== 'win32')(
    'wraps the managed hook command when the profile path contains a space (#6078)',
    async () => {
      const spaceHome = join(tmpdir(), 'orca home with spaces')
      mkdirSync(spaceHome, { recursive: true })
      homedirMock.mockReturnValue(spaceHome)
      try {
        const systemCodexHome = join(spaceHome, '.codex')
        mkdirSync(systemCodexHome, { recursive: true })

        const status = await new CodexHookService().install()
        expect(status.state).toBe('installed')

        const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
        const hooksConfig = JSON.parse(
          readFileSync(join(managedCodexHome, 'hooks.json'), 'utf-8')
        ) as { hooks: Record<string, { hooks?: { command?: string }[] }[]> }

        for (const eventName of localManagedCodexEvents()) {
          const command = hooksConfig.hooks[eventName]?.[0]?.hooks?.[0]?.command
          expect(command).toMatch(WINDOWS_POWERSHELL_LAUNCHER)
        }
      } finally {
        rmSync(spaceHome, { recursive: true, force: true })
      }
    }
  )

  // Why: cmd.exe expands `%` and treats `^` as an escape even inside otherwise
  // plausible paths. Keep those rare cases on the encoded launcher from #6078.
  it.skipIf(process.platform !== 'win32')(
    'keeps the encoded launcher when the profile path contains cmd metacharacters',
    async () => {
      const metacharHome = join(tmpdir(), 'orca %ORCA_TEST% ^ home')
      mkdirSync(metacharHome, { recursive: true })
      homedirMock.mockReturnValue(metacharHome)
      try {
        const systemCodexHome = join(metacharHome, '.codex')
        mkdirSync(systemCodexHome, { recursive: true })

        const status = await new CodexHookService().install()
        expect(status.state).toBe('installed')

        const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
        const hooksConfig = JSON.parse(
          readFileSync(join(managedCodexHome, 'hooks.json'), 'utf-8')
        ) as { hooks: Record<string, { hooks?: { command?: string }[] }[]> }

        for (const eventName of localManagedCodexEvents()) {
          const command = hooksConfig.hooks[eventName]?.[0]?.hooks?.[0]?.command
          expect(command).toMatch(WINDOWS_POWERSHELL_LAUNCHER)
        }
      } finally {
        rmSync(metacharHome, { recursive: true, force: true })
      }
    }
  )

  // Why: the common case — a profile path with no spaces or cmd metacharacters
  // — must launch the .cmd directly with no PowerShell, restoring the pre-#6078
  // speed that Codex 0.140's synchronous "Running <event> hook" rows expose.
  it.skipIf(process.platform !== 'win32')(
    'launches the managed .cmd directly when the profile path is cmd-safe',
    async () => {
      const status = await new CodexHookService().install()
      expect(status.state).toBe('installed')

      const managedCodexHome = join(homes.userDataDir, 'codex-runtime-home', 'home')
      const hooksConfig = JSON.parse(
        readFileSync(join(managedCodexHome, 'hooks.json'), 'utf-8')
      ) as { hooks: Record<string, { hooks?: { command?: string }[] }[]> }

      // Why: the temp home is normally cmd-safe; guard so a runner whose tmpdir
      // holds an exotic character still asserts the correct (fallback) branch.
      const command = hooksConfig.hooks.Stop?.[0]?.hooks?.[0]?.command ?? ''
      const cmdSafe = /^[A-Za-z0-9_.:\\~-]+$/.test(join(homes.tmpHome, '.orca', 'agent-hooks'))
      if (cmdSafe) {
        expect(command).not.toMatch(/powershell/i)
        expect(command).toMatch(/\\agent-hooks\\codex-hook\.cmd$/)
      } else {
        expect(command).toMatch(WINDOWS_POWERSHELL_LAUNCHER)
      }
    }
  )

  // Why: end-to-end proof the curl-based managed script posts the hook to the
  // local listener with UTF-8 (CJK) payloads and a worktreeId containing spaces
  // and a `&` — the cases the replaced PowerShell post and form quoting handled.
  it.skipIf(process.platform !== 'win32')(
    'posts hook payloads via the curl-based managed script preserving UTF-8 and spaced metadata',
    async () => {
      await new CodexHookService().install()
      const scriptPath = join(homedir(), '.orca', 'agent-hooks', 'codex-hook.cmd')
      expect(existsSync(scriptPath)).toBe(true)

      // Why: resolve when the listener has fully read the hook POST. spawnSync
      // would block the event loop and starve this handler, so the child is
      // spawned asynchronously while the server drains the request concurrently.
      let resolveReceived: (value: { headers: Record<string, unknown>; body: string }) => void
      const receivedPromise = new Promise<{
        headers: Record<string, unknown>
        body: string
      }>((resolve) => {
        resolveReceived = resolve
      })
      const server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          res.end('ok')
          resolveReceived({
            headers: req.headers,
            body: Buffer.concat(chunks).toString('utf-8')
          })
        })
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as AddressInfo).port

      try {
        const payload = JSON.stringify({
          prompt: '你好世界',
          hook_event_name: 'UserPromptSubmit'
        })
        // Why: this suite may run inside an Orca-launched terminal whose env
        // already carries ORCA_AGENT_HOOK_ENDPOINT/PORT/TOKEN. The managed
        // script sources that endpoint file, so leave it out or the hook posts
        // to the live Orca instead of this test's listener.
        const cleanEnv = { ...process.env }
        for (const key of Object.keys(cleanEnv)) {
          if (key.startsWith('ORCA_')) {
            delete cleanEnv[key]
          }
        }
        const child = spawn('cmd.exe', ['/d', '/c', scriptPath], {
          env: {
            ...cleanEnv,
            ORCA_AGENT_HOOK_PORT: String(port),
            ORCA_AGENT_HOOK_TOKEN: 'tok123',
            ORCA_PANE_KEY: '42:leaf-abc',
            ORCA_TAB_ID: '42',
            ORCA_WORKTREE_ID: 'C:\\work trees\\my repo & co',
            ORCA_AGENT_HOOK_VERSION: '1'
          }
        })
        child.stdin.end(payload)
        const exitCode = await new Promise<number>((resolve) => child.on('close', resolve))
        expect(exitCode).toBe(0)

        const received = await receivedPromise
        const params = new URLSearchParams(received.body)
        expect(received.headers['x-orca-agent-hook-token']).toBe('tok123')
        expect(params.get('paneKey')).toBe('42:leaf-abc')
        expect(params.get('worktreeId')).toBe('C:\\work trees\\my repo & co')
        expect(JSON.parse(params.get('payload') ?? '{}').prompt).toBe('你好世界')
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
  )

  it('keeps hooks isolated by Orca userData instead of mutating system ~/.codex', async () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    const existingSystemHooks = '{"hooks":{"Stop":[{"hooks":[{"command":"user-hook"}]}]}}\n'
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(systemHooksPath, existingSystemHooks, 'utf-8')

    const devUserDataDir = mkdtempSync(join(tmpdir(), 'orca-dev-codex-user-data-'))
    const prodUserDataDir = mkdtempSync(join(tmpdir(), 'orca-prod-codex-user-data-'))
    try {
      getPathMock.mockImplementation((name: string) => {
        if (name === 'userData') {
          return devUserDataDir
        }
        throw new Error(`unexpected app.getPath(${name})`)
      })
      process.env.ORCA_USER_DATA_PATH = devUserDataDir
      expect((await new CodexHookService().install()).state).toBe('installed')

      getPathMock.mockImplementation((name: string) => {
        if (name === 'userData') {
          return prodUserDataDir
        }
        throw new Error(`unexpected app.getPath(${name})`)
      })
      process.env.ORCA_USER_DATA_PATH = prodUserDataDir
      expect((await new CodexHookService().install()).state).toBe('installed')

      const devHooksPath = join(devUserDataDir, 'codex-runtime-home', 'home', 'hooks.json')
      const prodHooksPath = join(prodUserDataDir, 'codex-runtime-home', 'home', 'hooks.json')
      expect(existsSync(devHooksPath)).toBe(true)
      expect(existsSync(prodHooksPath)).toBe(true)
      const devHooks = JSON.parse(readFileSync(devHooksPath, 'utf-8')) as {
        hooks: Record<string, { hooks?: { command?: string }[] }[]>
      }
      const prodHooks = JSON.parse(readFileSync(prodHooksPath, 'utf-8')) as {
        hooks: Record<string, { hooks?: { command?: string }[] }[]>
      }
      expect(
        devHooks.hooks.Stop?.some((definition) =>
          definition.hooks?.some((hook) => hook.command === 'user-hook')
        )
      ).toBe(true)
      expect(
        prodHooks.hooks.Stop?.some((definition) =>
          definition.hooks?.some((hook) => hook.command === 'user-hook')
        )
      ).toBe(true)
      expect(
        devHooks.hooks.PreToolUse?.some((definition) =>
          isCodexManagedCommand(definition.hooks?.[0]?.command)
        )
      ).toBe(true)
      expect(
        prodHooks.hooks.PreToolUse?.some((definition) =>
          isCodexManagedCommand(definition.hooks?.[0]?.command)
        )
      ).toBe(true)
      expect(readFileSync(systemHooksPath, 'utf-8')).toBe(existingSystemHooks)
    } finally {
      process.env.ORCA_USER_DATA_PATH = homes.userDataDir
      rmSync(devUserDataDir, { recursive: true, force: true })
      rmSync(prodUserDataDir, { recursive: true, force: true })
    }
  })
})
