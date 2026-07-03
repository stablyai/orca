/* eslint-disable max-lines -- Why: this suite shares mocked homedir/userData setup across local/system Codex hook install, trust, and legacy-cleanup regressions. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createManagedCommandMatcher, wrapPosixHookCommand } from '../agent-hooks/installer-utils'
import { computeTrustedHash, upsertHookTrustEntriesInContent } from './config-toml-trust'

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

const WINDOWS_POWERSHELL_LAUNCHER =
  /^[A-Za-z]:\/[^"]*\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand \S+$/

let tmpHome: string
let userDataDir: string

function isCodexManagedCommand(command: string | undefined): boolean {
  const scriptFileName = process.platform === 'win32' ? 'codex-hook.cmd' : 'codex-hook.sh'
  return createManagedCommandMatcher(scriptFileName)(command)
}
let previousUserDataPath: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'orca-codex-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(tmpHome)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

function escapeTomlBasicString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function hookTrustHeader(key: string): string {
  const canonicalKey = canonicalizeHookTrustKeyForTest(key)
  return /^[A-Za-z]:[\\/]|^\\\\/.test(canonicalKey) && !canonicalKey.includes("'")
    ? `[hooks.state.'${canonicalKey}']`
    : `[hooks.state."${escapeTomlBasicString(canonicalKey)}"]`
}

function canonicalizeHookTrustKeyForTest(key: string): string {
  const lastColon = key.lastIndexOf(':')
  const secondLast = lastColon === -1 ? -1 : key.lastIndexOf(':', lastColon - 1)
  const thirdLast = secondLast === -1 ? -1 : key.lastIndexOf(':', secondLast - 1)
  if (thirdLast === -1) {
    return key
  }
  const sourcePath = key.slice(0, thirdLast)
  try {
    // Why: mirrors getCodexCanonicalTrustPath so test expectations match the
    // native raw-backslash keys Codex writes after hook approval on Windows.
    return `${realpathSync.native(sourcePath)}${key.slice(thirdLast)}`
  } catch {
    return /^[A-Za-z]:[\\/]|^\\\\/.test(sourcePath)
      ? `${sourcePath.replace(/\//g, '\\')}${key.slice(thirdLast)}`
      : key
  }
}

function markHookTrustDisabled(toml: string, header: string): string {
  const headerIndex = toml.indexOf(header)
  expect(headerIndex).not.toBe(-1)
  const nextHeaderIndex = toml.indexOf('\n[', headerIndex + header.length)
  const blockEnd = nextHeaderIndex === -1 ? toml.length : nextHeaderIndex
  const block = toml.slice(headerIndex, blockEnd)
  expect(block).toContain('enabled = true')
  return `${toml.slice(0, headerIndex)}${block.replace('enabled = true', 'enabled = false')}${toml.slice(blockEnd)}`
}

function localManagedCodexEvents(): string[] {
  return [
    'PermissionRequest',
    'PostToolUse',
    'PreToolUse',
    'SessionStart',
    'Stop',
    'UserPromptSubmit'
  ]
}

describe('CodexHookService', () => {
  it('installs PermissionRequest with trust so Codex approval prompts reach Orca', () => {
    const systemCodexHome = join(tmpHome, '.codex')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      join(systemCodexHome, 'config.toml'),
      'model = "gpt-5.2-codex"\napproval_policy = "on-request"\n',
      'utf-8'
    )

    const status = new CodexHookService().install()

    expect(status.state).toBe('installed')

    const managedCodexHome = join(userDataDir, 'codex-runtime-home', 'home')
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

  it('drops plugin manager metadata from runtime hooks.json during install', () => {
    const managedCodexHome = join(userDataDir, 'codex-runtime-home', 'home')
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

    expect(new CodexHookService().install().state).toBe('installed')

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
    () => {
      const spaceHome = join(tmpdir(), 'orca home with spaces')
      mkdirSync(spaceHome, { recursive: true })
      homedirMock.mockReturnValue(spaceHome)
      try {
        const systemCodexHome = join(spaceHome, '.codex')
        mkdirSync(systemCodexHome, { recursive: true })

        const status = new CodexHookService().install()
        expect(status.state).toBe('installed')

        const managedCodexHome = join(userDataDir, 'codex-runtime-home', 'home')
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
    () => {
      const metacharHome = join(tmpdir(), 'orca %ORCA_TEST% ^ home')
      mkdirSync(metacharHome, { recursive: true })
      homedirMock.mockReturnValue(metacharHome)
      try {
        const systemCodexHome = join(metacharHome, '.codex')
        mkdirSync(systemCodexHome, { recursive: true })

        const status = new CodexHookService().install()
        expect(status.state).toBe('installed')

        const managedCodexHome = join(userDataDir, 'codex-runtime-home', 'home')
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
    () => {
      const status = new CodexHookService().install()
      expect(status.state).toBe('installed')

      const managedCodexHome = join(userDataDir, 'codex-runtime-home', 'home')
      const hooksConfig = JSON.parse(
        readFileSync(join(managedCodexHome, 'hooks.json'), 'utf-8')
      ) as { hooks: Record<string, { hooks?: { command?: string }[] }[]> }

      // Why: the temp home is normally cmd-safe; guard so a runner whose tmpdir
      // holds an exotic character still asserts the correct (fallback) branch.
      const command = hooksConfig.hooks.Stop?.[0]?.hooks?.[0]?.command ?? ''
      const cmdSafe = /^[A-Za-z0-9_.:\\~-]+$/.test(join(tmpHome, '.orca', 'agent-hooks'))
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
      new CodexHookService().install()
      const scriptPath = join(homedir(), '.orca', 'agent-hooks', 'codex-hook.cmd')
      expect(existsSync(scriptPath)).toBe(true)

      // Why: resolve when the listener has fully read the hook POST. spawnSync
      // would block the event loop and starve this handler, so the child is
      // spawned asynchronously while the server drains the request concurrently.
      let resolveReceived: (value: { headers: Record<string, unknown>; body: string }) => void
      const receivedPromise = new Promise<{ headers: Record<string, unknown>; body: string }>(
        (resolve) => {
          resolveReceived = resolve
        }
      )
      const server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          res.end('ok')
          resolveReceived({ headers: req.headers, body: Buffer.concat(chunks).toString('utf-8') })
        })
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as AddressInfo).port

      try {
        const payload = JSON.stringify({ prompt: '你好世界', hook_event_name: 'UserPromptSubmit' })
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

  it('keeps hooks isolated by Orca userData instead of mutating system ~/.codex', () => {
    const systemCodexHome = join(tmpHome, '.codex')
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
      expect(new CodexHookService().install().state).toBe('installed')

      getPathMock.mockImplementation((name: string) => {
        if (name === 'userData') {
          return prodUserDataDir
        }
        throw new Error(`unexpected app.getPath(${name})`)
      })
      process.env.ORCA_USER_DATA_PATH = prodUserDataDir
      expect(new CodexHookService().install().state).toBe('installed')

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
      process.env.ORCA_USER_DATA_PATH = userDataDir
      rmSync(devUserDataDir, { recursive: true, force: true })
      rmSync(prodUserDataDir, { recursive: true, force: true })
    }
  })

  it('mirrors trusted system user hook approvals into the runtime CODEX_HOME', () => {
    const systemCodexHome = join(tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: 'user-hook',
                    timeout: 12,
                    async: true,
                    statusMessage: 'Running user hook'
                  }
                ]
              }
            ]
          }
        },
        null,
        2
      )}\n`,
      'utf-8'
    )
    writeFileSync(
      join(systemCodexHome, 'config.toml'),
      upsertHookTrustEntriesInContent('model = "system-model"\n', [
        {
          sourcePath: systemHooksPath,
          eventLabel: 'stop',
          groupIndex: 0,
          handlerIndex: 0,
          command: 'user-hook',
          timeoutSec: 12,
          async: true,
          matcher: '*',
          statusMessage: 'Running user hook'
        }
      ]),
      'utf-8'
    )

    expect(new CodexHookService().install().state).toBe('installed')

    const managedCodexHome = join(userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeHooks = JSON.parse(readFileSync(managedHooksPath, 'utf-8')) as {
      hooks: Record<
        string,
        { matcher?: string; hooks?: { command?: string; statusMessage?: string }[] }[]
      >
    }
    expect(runtimeHooks.hooks.Stop?.[1]?.matcher).toBe('*')
    expect(runtimeHooks.hooks.Stop?.[1]?.hooks?.[0]?.command).toBe('user-hook')
    expect(runtimeHooks.hooks.Stop?.[1]?.hooks?.[0]?.statusMessage).toBe('Running user hook')

    const runtimeToml = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:stop:1:0`))
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:stop:0:0`))
    expect(runtimeToml).not.toContain(hookTrustHeader(`${systemHooksPath}:stop:0:0`))
  })

  it('runs managed PostToolUse status before mirrored user hooks', () => {
    const systemCodexHome = join(tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify({
        hooks: {
          PostToolUse: [{ hooks: [{ type: 'command', command: 'slow-user-post-tool-hook' }] }]
        }
      })}\n`,
      'utf-8'
    )
    writeFileSync(
      join(systemCodexHome, 'config.toml'),
      upsertHookTrustEntriesInContent('model = "system-model"\n', [
        {
          sourcePath: systemHooksPath,
          eventLabel: 'post_tool_use',
          groupIndex: 0,
          handlerIndex: 0,
          command: 'slow-user-post-tool-hook'
        }
      ]),
      'utf-8'
    )

    expect(new CodexHookService().install().state).toBe('installed')

    const managedCodexHome = join(userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeHooks = JSON.parse(readFileSync(managedHooksPath, 'utf-8')) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
    }

    expect(isCodexManagedCommand(runtimeHooks.hooks.PostToolUse?.[0]?.hooks?.[0]?.command)).toBe(
      true
    )
    expect(runtimeHooks.hooks.PostToolUse?.[1]?.hooks?.[0]?.command).toBe(
      'slow-user-post-tool-hook'
    )

    const runtimeToml = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:post_tool_use:0:0`))
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:post_tool_use:1:0`))
    expect(runtimeToml).not.toContain(hookTrustHeader(`${systemHooksPath}:post_tool_use:0:0`))
  })

  it('mirrors system user hook approvals when the system trust indices are stale', () => {
    const systemCodexHome = join(tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify(
        {
          hooks: {
            Stop: [
              { hooks: [{ type: 'command', command: 'first-stop-hook' }] },
              { hooks: [{ type: 'command', command: 'second-stop-hook' }] }
            ]
          }
        },
        null,
        2
      )}\n`,
      'utf-8'
    )
    writeFileSync(
      join(systemCodexHome, 'config.toml'),
      upsertHookTrustEntriesInContent('model = "system-model"\n', [
        {
          sourcePath: systemHooksPath,
          eventLabel: 'stop',
          groupIndex: 0,
          handlerIndex: 0,
          command: 'second-stop-hook'
        },
        {
          sourcePath: systemHooksPath,
          eventLabel: 'stop',
          groupIndex: 1,
          handlerIndex: 0,
          command: 'first-stop-hook'
        }
      ]),
      'utf-8'
    )

    expect(new CodexHookService().install().state).toBe('installed')

    const managedCodexHome = join(userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeToml = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:stop:0:0`))
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:stop:1:0`))
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:stop:2:0`))
    expect(runtimeToml).not.toContain(hookTrustHeader(`${systemHooksPath}:stop:0:0`))
    expect(runtimeToml).not.toContain(hookTrustHeader(`${systemHooksPath}:stop:1:0`))
  })

  it('skips plugin-placeholder system hooks when mirroring into runtime CODEX_HOME', () => {
    const pluginCommands = [
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/on-stop.mjs"',
      'node "${CLAUDE_PLUGIN_DATA}/scripts/on-stop.mjs"',
      'node "${PLUGIN_ROOT}/scripts/on-stop.mjs"',
      'node "${PLUGIN_DATA}/scripts/on-stop.mjs"'
    ]
    const userCommand = 'user-stop-hook'
    const stopEventLabel = 'stop' as const
    const systemCodexHome = join(tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                hooks: [
                  ...pluginCommands.map((command) => ({ type: 'command', command })),
                  { type: 'command', command: userCommand }
                ]
              }
            ],
            PreCompact: pluginCommands.map((command) => ({
              hooks: [{ type: 'command', command }]
            }))
          }
        },
        null,
        2
      )}\n`,
      'utf-8'
    )
    writeFileSync(
      join(systemCodexHome, 'config.toml'),
      upsertHookTrustEntriesInContent('model = "system-model"\n', [
        ...pluginCommands.map((command, handlerIndex) => ({
          sourcePath: systemHooksPath,
          eventLabel: stopEventLabel,
          groupIndex: 0,
          handlerIndex,
          command
        })),
        {
          sourcePath: systemHooksPath,
          eventLabel: stopEventLabel,
          groupIndex: 0,
          handlerIndex: pluginCommands.length,
          command: userCommand
        }
      ]),
      'utf-8'
    )

    expect(new CodexHookService().install().state).toBe('installed')

    const managedCodexHome = join(userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeHooksText = readFileSync(managedHooksPath, 'utf-8')
    const runtimeHooks = JSON.parse(runtimeHooksText) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
    }
    const stopCommands =
      runtimeHooks.hooks.Stop?.flatMap(
        (definition) => definition.hooks?.map((hook) => hook.command ?? '') ?? []
      ) ?? []

    expect(stopCommands).toContain(userCommand)
    expect(stopCommands.some((command) => isCodexManagedCommand(command))).toBe(true)
    expect(runtimeHooks.hooks.PreCompact).toBeUndefined()
    for (const command of pluginCommands) {
      expect(runtimeHooksText).not.toContain(command)
    }

    const runtimeToml = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:stop:0:0`))
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:stop:1:0`))
    for (const command of pluginCommands) {
      expect(runtimeToml).not.toContain(command)
    }
  })

  it('mirrors compact-event user hook approvals and disabled trust entries', () => {
    const systemCodexHome = join(tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify(
        {
          hooks: {
            PreCompact: [{ hooks: [{ type: 'command', command: 'pre-compact-user' }] }],
            PostCompact: [{ hooks: [{ type: 'command', command: 'post-compact-disabled' }] }]
          }
        },
        null,
        2
      )}\n`,
      'utf-8'
    )
    const disabledPostCompactHeader = hookTrustHeader(`${systemHooksPath}:post_compact:0:0`)
    const systemToml = upsertHookTrustEntriesInContent('model = "system-model"\n', [
      {
        sourcePath: systemHooksPath,
        eventLabel: 'pre_compact',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'pre-compact-user'
      },
      {
        sourcePath: systemHooksPath,
        eventLabel: 'post_compact',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'post-compact-disabled'
      }
    ])
    writeFileSync(
      join(systemCodexHome, 'config.toml'),
      markHookTrustDisabled(systemToml, disabledPostCompactHeader),
      'utf-8'
    )

    expect(new CodexHookService().install().state).toBe('installed')

    const managedCodexHome = join(userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeHooks = JSON.parse(readFileSync(managedHooksPath, 'utf-8')) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
    }
    expect(runtimeHooks.hooks.PreCompact?.[0]?.hooks?.[0]?.command).toBe('pre-compact-user')
    expect(runtimeHooks.hooks.PostCompact?.[0]?.hooks?.[0]?.command).toBe('post-compact-disabled')

    const runtimeToml = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(runtimeToml).toContain(
      `${hookTrustHeader(`${managedHooksPath}:pre_compact:0:0`)}\nenabled = true`
    )
    expect(runtimeToml).toContain(
      `${hookTrustHeader(`${managedHooksPath}:post_compact:0:0`)}\nenabled = false`
    )
    expect(runtimeToml).not.toContain(hookTrustHeader(`${systemHooksPath}:pre_compact:0:0`))
    expect(runtimeToml).not.toContain(hookTrustHeader(`${systemHooksPath}:post_compact:0:0`))
  })

  it('removes runtime user hook trust after system approval is revoked', () => {
    const systemCodexHome = join(tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-hook' }] }] }
      })}\n`,
      'utf-8'
    )
    writeFileSync(
      join(systemCodexHome, 'config.toml'),
      upsertHookTrustEntriesInContent('model = "system-model"\n', [
        {
          sourcePath: systemHooksPath,
          eventLabel: 'stop',
          groupIndex: 0,
          handlerIndex: 0,
          command: 'user-hook'
        }
      ]),
      'utf-8'
    )
    const service = new CodexHookService()

    expect(service.install().state).toBe('installed')

    const managedCodexHome = join(userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeUserTrustHeader = hookTrustHeader(`${managedHooksPath}:stop:1:0`)
    expect(readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')).toContain(
      runtimeUserTrustHeader
    )

    writeFileSync(join(systemCodexHome, 'config.toml'), 'model = "system-model"\n', 'utf-8')
    expect(service.install().state).toBe('installed')

    const runtimeToml = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(runtimeToml).not.toContain(runtimeUserTrustHeader)
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:stop:0:0`))
  })

  it('refreshes mirrored system user hooks when the system hooks file changes', () => {
    const systemCodexHome = join(tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-hook-old' }] }] }
      })}\n`,
      'utf-8'
    )

    const service = new CodexHookService()
    expect(service.install().state).toBe('installed')

    writeFileSync(
      systemHooksPath,
      `${JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-hook-new' }] }] }
      })}\n`,
      'utf-8'
    )
    expect(service.install().state).toBe('installed')

    const managedHooksPath = join(userDataDir, 'codex-runtime-home', 'home', 'hooks.json')
    const runtimeHooks = JSON.parse(readFileSync(managedHooksPath, 'utf-8')) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
    }
    const stopCommands =
      runtimeHooks.hooks.Stop?.flatMap(
        (definition) => definition.hooks?.map((hook) => hook.command ?? '') ?? []
      ) ?? []
    expect(stopCommands).toContain('user-hook-new')
    expect(stopCommands).not.toContain('user-hook-old')
  })

  it('refreshes runtime user hooks without installing Orca-managed hooks', () => {
    const systemCodexHome = join(tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-stop-hook' }] }] }
      })}\n`,
      'utf-8'
    )
    const disabledStopHeader = hookTrustHeader(`${systemHooksPath}:stop:0:0`)
    const systemToml = upsertHookTrustEntriesInContent('model = "system-model"\n', [
      {
        sourcePath: systemHooksPath,
        eventLabel: 'stop',
        groupIndex: 0,
        handlerIndex: 0,
        command: 'user-stop-hook'
      }
    ])
    writeFileSync(
      join(systemCodexHome, 'config.toml'),
      markHookTrustDisabled(systemToml, disabledStopHeader),
      'utf-8'
    )

    const service = new CodexHookService()
    expect(service.install().state).toBe('installed')
    const managedCodexHome = join(userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeTomlPath = join(managedCodexHome, 'config.toml')
    const permissionRequestHeader = hookTrustHeader(`${managedHooksPath}:permission_request:0:0`)
    const installedToml = readFileSync(runtimeTomlPath, 'utf-8')
    const permissionRequestIndex = installedToml.indexOf(permissionRequestHeader)
    expect(permissionRequestIndex).not.toBe(-1)
    const nextHeaderIndex = installedToml.indexOf(
      '\n[',
      permissionRequestIndex + permissionRequestHeader.length
    )
    const permissionRequestBlock = installedToml.slice(
      permissionRequestIndex,
      nextHeaderIndex === -1 ? installedToml.length : nextHeaderIndex
    )
    writeFileSync(
      runtimeTomlPath,
      `${installedToml.trimEnd()}\n\n${permissionRequestBlock.trimEnd()}\n`,
      'utf-8'
    )

    const status = service.refreshRuntimeUserHooks()

    expect(status.state).toBe('not_installed')
    expect(status.managedHooksPresent).toBe(false)
    const runtimeHooks = JSON.parse(readFileSync(managedHooksPath, 'utf-8')) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
    }
    const runtimeCommands = Object.values(runtimeHooks.hooks).flatMap((definitions) =>
      definitions.flatMap((definition) => definition.hooks?.map((hook) => hook.command ?? '') ?? [])
    )
    expect(runtimeCommands).toEqual(['user-stop-hook'])
    expect(runtimeCommands.some((command) => command.includes('codex-hook'))).toBe(false)

    const runtimeToml = readFileSync(runtimeTomlPath, 'utf-8')
    expect(runtimeToml).toContain(
      `${hookTrustHeader(`${managedHooksPath}:stop:0:0`)}\nenabled = false`
    )
    expect(runtimeToml).not.toContain(':permission_request:0:0')
  })

  it('removes legacy Orca-managed hooks from system ~/.codex during install', () => {
    const systemCodexHome = join(tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    const legacyScriptPath = join(
      tmpHome,
      '.orca',
      'agent-hooks',
      process.platform === 'win32' ? 'codex-hook.cmd' : 'codex-hook.sh'
    )
    const legacyCommand =
      process.platform === 'win32' ? legacyScriptPath : wrapPosixHookCommand(legacyScriptPath)
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify(
        {
          hooks: {
            Stop: [
              { hooks: [{ type: 'command', command: 'user-hook' }] },
              { hooks: [{ type: 'command', command: legacyCommand }] }
            ],
            SessionStart: [{ hooks: [{ type: 'command', command: legacyCommand }] }]
          },
          _managed: {
            'external-manager': {
              Stop: [0]
            }
          }
        },
        null,
        2
      )}\n`,
      'utf-8'
    )
    writeFileSync(
      join(systemCodexHome, 'config.toml'),
      upsertHookTrustEntriesInContent('model = "system-model"\n', [
        {
          sourcePath: systemHooksPath,
          eventLabel: 'stop',
          groupIndex: 1,
          handlerIndex: 0,
          command: legacyCommand
        },
        {
          sourcePath: systemHooksPath,
          eventLabel: 'session_start',
          groupIndex: 0,
          handlerIndex: 0,
          command: legacyCommand
        }
      ]),
      'utf-8'
    )

    expect(new CodexHookService().install().state).toBe('installed')

    const systemHooks = JSON.parse(readFileSync(systemHooksPath, 'utf-8')) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
      _managed?: unknown
    }
    expect(systemHooks.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'user-hook' }] }])
    expect(systemHooks.hooks.SessionStart).toBeUndefined()
    expect(systemHooks._managed).toEqual({ 'external-manager': { Stop: [0] } })
    const systemToml = readFileSync(join(systemCodexHome, 'config.toml'), 'utf-8')
    expect(systemToml).toContain('model = "system-model"')
    expect(systemToml).not.toContain(':stop:1:0')
    expect(systemToml).not.toContain(':session_start:0:0')
  })

  it('removes very large legacy Orca-managed hook lists from system ~/.codex', () => {
    const systemCodexHome = join(tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    const legacyScriptPath = join(
      tmpHome,
      '.orca',
      'agent-hooks',
      process.platform === 'win32' ? 'codex-hook.cmd' : 'codex-hook.sh'
    )
    const legacyCommand =
      process.platform === 'win32' ? legacyScriptPath : wrapPosixHookCommand(legacyScriptPath)
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify({
        hooks: {
          Stop: Array.from({ length: 30_000 }, () => ({
            hooks: [{ type: 'command', command: legacyCommand }]
          }))
        }
      })}\n`,
      'utf-8'
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      expect(new CodexHookService().install().state).toBe('installed')

      expect(warnSpy).not.toHaveBeenCalledWith(
        '[codex-hook-service] failed to clean legacy Codex hooks',
        expect.anything()
      )
    } finally {
      warnSpy.mockRestore()
    }
    const systemHooks = JSON.parse(readFileSync(systemHooksPath, 'utf-8')) as {
      hooks: Record<string, unknown>
    }
    expect(systemHooks.hooks.Stop).toBeUndefined()
  }, 30_000)

  it('removes the legacy Orca Codex profile file when it only contains managed hooks', () => {
    const systemCodexHome = join(tmpHome, '.codex')
    const profilePath = join(systemCodexHome, 'orca-agent-status.config.toml')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      profilePath,
      [
        '# BEGIN ORCA AGENT STATUS HOOKS',
        '[[hooks.PermissionRequest]]',
        '[[hooks.PermissionRequest.hooks]]',
        'type = "command"',
        'command = "codex-hook"',
        '# END ORCA AGENT STATUS HOOKS',
        ''
      ].join('\n'),
      'utf-8'
    )

    expect(new CodexHookService().install().state).toBe('installed')

    expect(existsSync(profilePath)).toBe(false)
  })

  it('removes only the legacy Orca block from a user-edited Codex profile file', () => {
    const systemCodexHome = join(tmpHome, '.codex')
    const profilePath = join(systemCodexHome, 'orca-agent-status.config.toml')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      profilePath,
      [
        'model = "gpt-5.5"',
        '',
        '# BEGIN ORCA AGENT STATUS HOOKS',
        '[[hooks.PermissionRequest]]',
        '[[hooks.PermissionRequest.hooks]]',
        'type = "command"',
        'command = "codex-hook"',
        '# END ORCA AGENT STATUS HOOKS',
        ''
      ].join('\n'),
      'utf-8'
    )

    expect(new CodexHookService().install().state).toBe('installed')

    const profileConfig = readFileSync(profilePath, 'utf-8')
    expect(profileConfig).toContain('model = "gpt-5.5"')
    expect(profileConfig).not.toContain('ORCA AGENT STATUS HOOKS')
    expect(profileConfig).not.toContain('codex-hook')
  })

  it('cleans legacy system and profile hooks when runtime hooks.json is malformed during remove', () => {
    const managedCodexHome = join(userDataDir, 'codex-runtime-home', 'home')
    mkdirSync(managedCodexHome, { recursive: true })
    writeFileSync(join(managedCodexHome, 'hooks.json'), '{not json', 'utf-8')

    const systemCodexHome = join(tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    const profilePath = join(systemCodexHome, 'orca-agent-status.config.toml')
    const legacyScriptPath = join(
      tmpHome,
      '.orca',
      'agent-hooks',
      process.platform === 'win32' ? 'codex-hook.cmd' : 'codex-hook.sh'
    )
    const legacyCommand =
      process.platform === 'win32' ? legacyScriptPath : wrapPosixHookCommand(legacyScriptPath)
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify(
        {
          hooks: {
            Stop: [
              { hooks: [{ type: 'command', command: 'user-hook' }] },
              { hooks: [{ type: 'command', command: legacyCommand }] }
            ],
            SessionStart: [{ hooks: [{ type: 'command', command: legacyCommand }] }]
          }
        },
        null,
        2
      )}\n`,
      'utf-8'
    )
    writeFileSync(
      profilePath,
      [
        '# BEGIN ORCA AGENT STATUS HOOKS',
        '[[hooks.PermissionRequest]]',
        '[[hooks.PermissionRequest.hooks]]',
        'type = "command"',
        'command = "codex-hook"',
        '# END ORCA AGENT STATUS HOOKS',
        ''
      ].join('\n'),
      'utf-8'
    )

    const status = new CodexHookService().remove()

    expect(status.state).toBe('error')
    expect(status.detail).toBe('Could not parse Codex hooks.json')
    const systemHooks = JSON.parse(readFileSync(systemHooksPath, 'utf-8')) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
    }
    expect(systemHooks.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'user-hook' }] }])
    expect(systemHooks.hooks.SessionStart).toBeUndefined()
    expect(existsSync(profilePath)).toBe(false)
  })

  it('sanitizes runtime hooks.json metadata during remove even without managed hooks', () => {
    const managedCodexHome = join(userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    mkdirSync(managedCodexHome, { recursive: true })
    writeFileSync(
      managedHooksPath,
      `${JSON.stringify(
        {
          hooks: {
            Stop: [{ hooks: [{ type: 'command', command: 'user-hook' }] }]
          },
          _managed: {
            'compound-engineering': {
              Stop: [0]
            }
          }
        },
        null,
        2
      )}\n`,
      'utf-8'
    )

    const status = new CodexHookService().remove()

    expect(status.state).toBe('not_installed')
    const hooksConfig = JSON.parse(readFileSync(managedHooksPath, 'utf-8')) as {
      hooks: Record<string, unknown>
      _managed?: unknown
    }
    expect(hooksConfig._managed).toBeUndefined()
    expect(Object.keys(hooksConfig)).toEqual(['hooks'])
    expect(hooksConfig.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: 'user-hook' }] }])
  })

  it('cleans duplicate Codex hook representations while keeping status hooks in runtime CODEX_HOME', () => {
    const systemCodexHome = join(tmpHome, '.codex')
    const systemHooksPath = join(systemCodexHome, 'hooks.json')
    const systemTomlPath = join(systemCodexHome, 'config.toml')
    const legacyProfilePath = join(systemCodexHome, 'orca-agent-status.config.toml')
    const legacyScriptPath = join(
      tmpHome,
      '.orca',
      'agent-hooks',
      process.platform === 'win32' ? 'codex-hook.cmd' : 'codex-hook.sh'
    )
    const legacyCommand =
      process.platform === 'win32' ? legacyScriptPath : wrapPosixHookCommand(legacyScriptPath)
    const userCommand = 'user-stop-hook'
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      systemHooksPath,
      `${JSON.stringify(
        {
          hooks: {
            Stop: [
              { hooks: [{ type: 'command', command: userCommand }] },
              { hooks: [{ type: 'command', command: legacyCommand }] }
            ],
            SessionStart: [{ hooks: [{ type: 'command', command: legacyCommand }] }]
          }
        },
        null,
        2
      )}\n`,
      'utf-8'
    )
    writeFileSync(
      systemTomlPath,
      upsertHookTrustEntriesInContent(
        ['model = "system-model"', '', '[features]', 'codex_hooks = true', ''].join('\n'),
        [
          {
            sourcePath: systemHooksPath,
            eventLabel: 'stop',
            groupIndex: 0,
            handlerIndex: 0,
            command: userCommand
          },
          {
            sourcePath: systemHooksPath,
            eventLabel: 'session_start',
            groupIndex: 0,
            handlerIndex: 0,
            command: legacyCommand
          }
        ]
      ),
      'utf-8'
    )
    writeFileSync(
      legacyProfilePath,
      [
        '# BEGIN ORCA AGENT STATUS HOOKS',
        '[[hooks.PermissionRequest]]',
        '[[hooks.PermissionRequest.hooks]]',
        'type = "command"',
        'command = "codex-hook"',
        '# END ORCA AGENT STATUS HOOKS',
        ''
      ].join('\n'),
      'utf-8'
    )

    const service = new CodexHookService()
    expect(service.install().state).toBe('installed')

    const managedCodexHome = join(userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeHooks = JSON.parse(readFileSync(managedHooksPath, 'utf-8')) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
    }
    const stopCommands =
      runtimeHooks.hooks.Stop?.flatMap(
        (definition) => definition.hooks?.map((hook) => hook.command ?? '') ?? []
      ) ?? []
    expect(stopCommands).toContain(userCommand)
    expect(stopCommands.some((command) => isCodexManagedCommand(command))).toBe(true)
    expect(
      isCodexManagedCommand(runtimeHooks.hooks.PermissionRequest?.[0]?.hooks?.[0]?.command)
    ).toBe(true)

    const runtimeToml = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(runtimeToml).toContain('[features]\nhooks = true')
    expect(runtimeToml).not.toContain('codex_hooks')
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:stop:0:0`))
    expect(runtimeToml).toContain(hookTrustHeader(`${managedHooksPath}:permission_request:0:0`))

    const systemHooks = JSON.parse(readFileSync(systemHooksPath, 'utf-8')) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
    }
    expect(systemHooks.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: userCommand }] }])
    expect(systemHooks.hooks.SessionStart).toBeUndefined()
    const systemToml = readFileSync(systemTomlPath, 'utf-8')
    expect(systemToml).toContain('codex_hooks = true')
    expect(systemToml).not.toContain(':session_start:0:0')
    expect(existsSync(legacyProfilePath)).toBe(false)
    expect(service.getStatus().state).toBe('installed')
  })

  it('removes managed trust entries when userData resolves through a symlink', () => {
    const linkedUserDataDir = join(tmpHome, 'linked-user-data')
    symlinkSync(userDataDir, linkedUserDataDir, process.platform === 'win32' ? 'junction' : 'dir')
    process.env.ORCA_USER_DATA_PATH = linkedUserDataDir

    const service = new CodexHookService()
    expect(service.install().state).toBe('installed')

    const linkedManagedCodexHome = join(linkedUserDataDir, 'codex-runtime-home', 'home')
    const linkedHooksPath = join(linkedManagedCodexHome, 'hooks.json')
    let runtimeToml = readFileSync(join(linkedManagedCodexHome, 'config.toml'), 'utf-8')
    expect(runtimeToml).toContain(hookTrustHeader(`${linkedHooksPath}:permission_request:0:0`))

    const status = service.remove()

    expect(status.state).toBe('not_installed')
    runtimeToml = readFileSync(join(linkedManagedCodexHome, 'config.toml'), 'utf-8')
    expect(runtimeToml).not.toContain(':permission_request:0:0')
    expect(runtimeToml).not.toContain(':stop:0:0')
  })

  it('removes legacy managed trust entries hashed before hook timeouts existed', () => {
    const service = new CodexHookService()
    expect(service.install().state).toBe('installed')

    const managedCodexHome = join(userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeTomlPath = join(managedCodexHome, 'config.toml')
    const hooksConfig = JSON.parse(readFileSync(managedHooksPath, 'utf-8')) as {
      hooks: Record<string, { hooks?: { command?: string }[] }[]>
    }
    const command = hooksConfig.hooks.PermissionRequest?.[0]?.hooks?.[0]?.command
    expect(command).toBeDefined()
    const legacyHash = computeTrustedHash({
      sourcePath: managedHooksPath,
      eventLabel: 'permission_request',
      groupIndex: 0,
      handlerIndex: 0,
      command: command!
    })
    writeFileSync(
      runtimeTomlPath,
      [
        hookTrustHeader(`${managedHooksPath}:permission_request:0:0`),
        'enabled = true',
        `trusted_hash = "${legacyHash}"`,
        ''
      ].join('\n'),
      'utf-8'
    )

    expect(service.remove().state).toBe('not_installed')

    const runtimeToml = readFileSync(runtimeTomlPath, 'utf-8')
    expect(runtimeToml).not.toContain(':permission_request:0:0')
  })

  it('mirrors system Codex config while preserving runtime hook trust on hook install', () => {
    const systemCodexHome = join(tmpHome, '.codex')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(join(systemCodexHome, 'config.toml'), 'model = "system-model"\n', 'utf-8')

    const managedCodexHome = join(userDataDir, 'codex-runtime-home', 'home')
    mkdirSync(managedCodexHome, { recursive: true })
    writeFileSync(
      join(managedCodexHome, 'config.toml'),
      [
        'model = "runtime-model"',
        '',
        '[hooks.state."runtime-hook"]',
        'enabled = false',
        'trusted_hash = "sha256:runtime"',
        ''
      ].join('\n'),
      'utf-8'
    )

    const status = new CodexHookService().install()

    expect(status.state).toBe('installed')
    const trustConfig = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(trustConfig).toContain('model = "system-model"')
    expect(trustConfig).toContain('[hooks.state."runtime-hook"]')
    expect(trustConfig).toContain('enabled = false')
    expect(trustConfig).toContain('trusted_hash = "sha256:runtime"')
    expect(trustConfig).toContain(':permission_request:0:0')
    expect(trustConfig).not.toContain('model = "runtime-model"')
  })

  it.skipIf(process.platform !== 'win32')(
    'treats legacy forward-slash runtime trust keys as installed before canonicalizing on reinstall',
    () => {
      const service = new CodexHookService()
      expect(service.install().state).toBe('installed')

      const managedCodexHome = join(userDataDir, 'codex-runtime-home', 'home')
      const managedHooksPath = join(managedCodexHome, 'hooks.json')
      const runtimeTomlPath = join(managedCodexHome, 'config.toml')
      const canonicalPermissionHeader = hookTrustHeader(
        `${managedHooksPath}:permission_request:0:0`
      )
      const legacyPermissionHeader = `[hooks.state."${escapeTomlBasicString(
        `${realpathSync.native(managedHooksPath).replace(/\\/g, '/')}:permission_request:0:0`
      )}"]`
      const installedToml = readFileSync(runtimeTomlPath, 'utf-8')
      expect(installedToml).toContain(canonicalPermissionHeader)

      writeFileSync(
        runtimeTomlPath,
        installedToml.replace(canonicalPermissionHeader, legacyPermissionHeader),
        'utf-8'
      )

      const legacyToml = readFileSync(runtimeTomlPath, 'utf-8')
      expect(legacyToml).toContain(legacyPermissionHeader)
      expect(service.getStatus().state).toBe('installed')

      expect(service.install().state).toBe('installed')

      const repairedToml = readFileSync(runtimeTomlPath, 'utf-8')
      expect(repairedToml).not.toContain(legacyPermissionHeader)
      expect(repairedToml).toContain(canonicalPermissionHeader)
      expect(service.getStatus().state).toBe('installed')
    }
  )

  it('repairs duplicate managed PermissionRequest trust tables on restart install', () => {
    const systemCodexHome = join(tmpHome, '.codex')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(join(systemCodexHome, 'config.toml'), 'model = "system-model"\n', 'utf-8')

    const service = new CodexHookService()
    expect(service.install().state).toBe('installed')

    const managedCodexHome = join(userDataDir, 'codex-runtime-home', 'home')
    const managedHooksPath = join(managedCodexHome, 'hooks.json')
    const runtimeTomlPath = join(managedCodexHome, 'config.toml')
    const permissionRequestHeader = hookTrustHeader(`${managedHooksPath}:permission_request:0:0`)
    const installedToml = readFileSync(runtimeTomlPath, 'utf-8')
    const permissionRequestIndex = installedToml.indexOf(permissionRequestHeader)
    expect(permissionRequestIndex).not.toBe(-1)
    const nextHeaderIndex = installedToml.indexOf(
      '\n[',
      permissionRequestIndex + permissionRequestHeader.length
    )
    const permissionRequestBlock = installedToml
      .slice(
        permissionRequestIndex,
        nextHeaderIndex === -1 ? installedToml.length : nextHeaderIndex
      )
      .trimEnd()
    const staleDisabledBlock = permissionRequestBlock
      .replace('enabled = true', 'enabled = false')
      .replace(/trusted_hash = "[^"]+"/, 'trusted_hash = "sha256:STALE_DISABLED"')
    const staleEnabledBlock = permissionRequestBlock.replace(
      /trusted_hash = "[^"]+"/,
      'trusted_hash = "sha256:STALE_ENABLED"'
    )
    writeFileSync(
      runtimeTomlPath,
      `${installedToml.slice(
        0,
        permissionRequestIndex
      )}${staleDisabledBlock}\n\n${staleEnabledBlock}${installedToml.slice(
        nextHeaderIndex === -1 ? installedToml.length : nextHeaderIndex
      )}`,
      'utf-8'
    )
    expect(readFileSync(runtimeTomlPath, 'utf-8').split(permissionRequestHeader)).toHaveLength(3)

    // Why: preserving `enabled = false` is the repair contract; status can be
    // partial because the user-disabled managed hook remains disabled.
    expect(['installed', 'partial']).toContain(service.install().state)

    const repairedToml = readFileSync(runtimeTomlPath, 'utf-8')
    expect(repairedToml.split(permissionRequestHeader)).toHaveLength(2)
    expect(repairedToml).toContain('enabled = false')
    expect(repairedToml).not.toContain('STALE_DISABLED')
    expect(repairedToml).not.toContain('STALE_ENABLED')
    expect(repairedToml).toContain('model = "system-model"')
  })

  it('preserves runtime-only project trust while honoring system project untrust', () => {
    const systemCodexHome = join(tmpHome, '.codex')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(
      join(systemCodexHome, 'config.toml'),
      ['model = "system-model"', '', '[projects."/repo"]', 'trust_level = "untrusted"', ''].join(
        '\n'
      ),
      'utf-8'
    )

    const managedCodexHome = join(userDataDir, 'codex-runtime-home', 'home')
    mkdirSync(managedCodexHome, { recursive: true })
    writeFileSync(
      join(managedCodexHome, 'config.toml'),
      [
        'model = "runtime-model"',
        '',
        '[projects."/repo"]',
        'trust_level = "trusted"',
        '',
        '[projects."/runtime-only"]',
        'trust_level = "trusted"',
        ''
      ].join('\n'),
      'utf-8'
    )

    const status = new CodexHookService().install()

    expect(status.state).toBe('installed')
    const trustConfig = readFileSync(join(managedCodexHome, 'config.toml'), 'utf-8')
    expect(trustConfig).toContain('model = "system-model"')
    expect(trustConfig).toContain('[projects."/repo"]\ntrust_level = "untrusted"')
    expect(trustConfig).toContain('[projects."/runtime-only"]\ntrust_level = "trusted"')
    expect(trustConfig).not.toContain('model = "runtime-model"')
  })
})
