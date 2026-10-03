import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { homedir, tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeManagedScript } from '../agent-hooks/installer-utils'
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
import { getManagedScriptPath } from './codex-hook-definition'
import { getManagedScript } from './codex-hook-script'
import { runExclusivelyForCodexTrustConfig } from './codex-trust-config-mutation-queue'

const homes = setupCodexHookHomes(homedirMock, getPathMock)

type HooksJson = { hooks: Record<string, { hooks?: { command?: string }[] }[]> }

function readHooksJson(path: string): HooksJson {
  const config: HooksJson = JSON.parse(readFileSync(path, 'utf-8'))
  return config
}

function hasOrcaEntry(hooks: HooksJson['hooks']): boolean {
  return Object.values(hooks).some((definitions) =>
    definitions.some((definition) =>
      definition.hooks?.some((hook) => isCodexManagedCommand(hook.command))
    )
  )
}

describe('CodexHookService', () => {
  // Why (#16441): the refresh promotes in-Orca approvals into ~/.codex/config.toml
  // and mirrors that file into the managed home, so holding only the runtime
  // lane would let it land inside another writer's capture->restore window.
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

  it('refreshes a per-account self-contained home, not the shared mirror, with no Orca entry', async () => {
    const systemCodexHome = join(homes.tmpHome, '.codex')
    mkdirSync(systemCodexHome, { recursive: true })
    writeFileSync(join(systemCodexHome, 'config.toml'), 'approval_policy = "on-request"\n', 'utf-8')

    const perAccountHome = join(homes.userDataDir, 'codex-accounts', 'account-1', 'home')
    mkdirSync(perAccountHome, { recursive: true })
    writeFileSync(join(perAccountHome, '.orca-managed-home'), 'account-1\n', 'utf-8')

    const status = await new CodexHookService().refreshRuntimeUserHooks(perAccountHome)
    expect(status.state).toBe('not_installed')

    // The refresh lands in THIS account's home, carrying no Orca entry or trust.
    const hooksConfig = readHooksJson(join(perAccountHome, 'hooks.json'))
    expect(hasOrcaEntry(hooksConfig.hooks)).toBe(false)
    const trustConfig = readFileSync(join(perAccountHome, 'config.toml'), 'utf-8')
    expect(trustConfig).toContain('approval_policy = "on-request"')
    expect(trustConfig).not.toContain('[hooks.state')

    // The shared runtime mirror is never touched by a per-account refresh.
    expect(existsSync(join(homes.userDataDir, 'codex-runtime-home', 'home', 'hooks.json'))).toBe(
      false
    )
    // ~/.codex is only read for canonical config, never mutated with hooks.
    expect(existsSync(join(systemCodexHome, 'hooks.json'))).toBe(false)
  })

  it('drops plugin manager metadata from runtime hooks.json during the refresh', async () => {
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

    expect((await new CodexHookService().refreshRuntimeUserHooks()).state).toBe('not_installed')

    const hooksConfig = JSON.parse(readFileSync(join(managedCodexHome, 'hooks.json'), 'utf-8')) as {
      hooks: Record<string, unknown>
      _managed?: unknown
    }
    expect(hooksConfig._managed).toBeUndefined()
    expect(Object.keys(hooksConfig)).toEqual(['hooks'])
  })

  // Why: end-to-end proof the curl-based managed script posts the hook to the
  // local listener with UTF-8 (CJK) payloads and a worktreeId containing spaces
  // and a `&` — the cases the replaced PowerShell post and form quoting handled.
  it.skipIf(process.platform !== 'win32')(
    'posts hook payloads via the curl-based managed script preserving UTF-8 and spaced metadata',
    async () => {
      writeManagedScript(getManagedScriptPath(), getManagedScript())
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
      expect((await new CodexHookService().refreshRuntimeUserHooks()).state).toBe('not_installed')

      getPathMock.mockImplementation((name: string) => {
        if (name === 'userData') {
          return prodUserDataDir
        }
        throw new Error(`unexpected app.getPath(${name})`)
      })
      process.env.ORCA_USER_DATA_PATH = prodUserDataDir
      expect((await new CodexHookService().refreshRuntimeUserHooks()).state).toBe('not_installed')

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
      expect(hasOrcaEntry(devHooks.hooks)).toBe(false)
      expect(hasOrcaEntry(prodHooks.hooks)).toBe(false)
      expect(readFileSync(systemHooksPath, 'utf-8')).toBe(existingSystemHooks)
    } finally {
      process.env.ORCA_USER_DATA_PATH = homes.userDataDir
      removeTreeSync(devUserDataDir)
      removeTreeSync(prodUserDataDir)
    }
  })
})
