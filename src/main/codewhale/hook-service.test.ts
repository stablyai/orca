import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import type * as osModule from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyManagedCodeWhaleHooks, CODEWHALE_HOOK_EVENTS } from './hook-config-toml'

let home: string
let originalHome: string | undefined
let originalCodeWhaleConfigPath: string | undefined
let originalDeepSeekConfigPath: string | undefined
let originalCodeWhaleHome: string | undefined

beforeEach(() => {
  vi.resetModules()
  home = mkdtempSync(join(tmpdir(), 'orca-codewhale-hook-'))
  originalHome = process.env.HOME
  originalCodeWhaleConfigPath = process.env.CODEWHALE_CONFIG_PATH
  originalDeepSeekConfigPath = process.env.DEEPSEEK_CONFIG_PATH
  originalCodeWhaleHome = process.env.CODEWHALE_HOME
  process.env.HOME = home
  process.env.CODEWHALE_CONFIG_PATH = configPath()
  delete process.env.DEEPSEEK_CONFIG_PATH
  delete process.env.CODEWHALE_HOME
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof osModule>('os')
    return { ...actual, homedir: () => home }
  })
})

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }
  if (originalCodeWhaleConfigPath === undefined) {
    delete process.env.CODEWHALE_CONFIG_PATH
  } else {
    process.env.CODEWHALE_CONFIG_PATH = originalCodeWhaleConfigPath
  }
  if (originalDeepSeekConfigPath === undefined) {
    delete process.env.DEEPSEEK_CONFIG_PATH
  } else {
    process.env.DEEPSEEK_CONFIG_PATH = originalDeepSeekConfigPath
  }
  if (originalCodeWhaleHome === undefined) {
    delete process.env.CODEWHALE_HOME
  } else {
    process.env.CODEWHALE_HOME = originalCodeWhaleHome
  }
  vi.doUnmock('os')
  rmSync(home, { recursive: true, force: true })
})

const configPath = (): string => join(home, '.codewhale', 'config.toml')
const scriptFileName = (): string =>
  process.platform === 'win32' ? 'codewhale-hook.cmd' : 'codewhale-hook.sh'
const scriptPath = (): string => join(home, '.orca', 'agent-hooks', scriptFileName())

describe('CodeWhaleHookService', () => {
  it('reports not_installed before install', async () => {
    const { CodeWhaleHookService } = await import('./hook-service')
    expect(new CodeWhaleHookService().getStatus().state).toBe('not_installed')
  })

  it('installs the managed hooks block and managed script', async () => {
    const { CodeWhaleHookService } = await import('./hook-service')
    const status = new CodeWhaleHookService().install()

    expect(status.state).toBe('installed')
    expect(status.managedHooksPresent).toBe(true)

    const config = readFileSync(configPath(), 'utf-8')
    for (const event of CODEWHALE_HOOK_EVENTS) {
      expect(config).toContain(`event = "${event}"`)
    }
    expect(config.replaceAll('\\', '/')).toContain(`agent-hooks/${scriptFileName()}`)

    const script = readFileSync(scriptPath(), 'utf-8')
    expect(script).toContain('/hook/codewhale')
    expect(script).toContain('hook_event_name')
    expect(script).toContain('ORCA_CODEWHALE_HOOK_EVENT')
    expect(script).toContain('DEEPSEEK_TOOL_NAME')
  })

  it('keeps user config when installing, then restores it on remove', async () => {
    const dir = join(home, '.codewhale')
    mkdirSync(dir, { recursive: true })
    const userConfig =
      '[hooks]\nenabled = true\n\n[[hooks.hooks]]\nevent = "shell_env"\ncommand = "echo mine"\n'
    writeFileSync(configPath(), userConfig)

    const { CodeWhaleHookService } = await import('./hook-service')
    const service = new CodeWhaleHookService()
    expect(service.install().state).toBe('installed')

    const installed = readFileSync(configPath(), 'utf-8')
    expect(installed).toContain('command = "echo mine"')
    expect(existsSync(`${configPath()}.bak`)).toBe(false)

    service.install()
    const reinstalled = readFileSync(configPath(), 'utf-8')
    expect((reinstalled.match(/orca-managed-codewhale-hooks \(/g) ?? []).length).toBe(1)

    const removed = service.remove()
    expect(removed.state).toBe('not_installed')
    expect(readFileSync(configPath(), 'utf-8')).toBe(userConfig)
  })

  it('honors DEEPSEEK_CONFIG_PATH when CODEWHALE_CONFIG_PATH is absent', async () => {
    delete process.env.CODEWHALE_CONFIG_PATH
    process.env.DEEPSEEK_CONFIG_PATH = join(home, '.deepseek', 'config.toml')

    const { CodeWhaleHookService } = await import('./hook-service')
    const status = new CodeWhaleHookService().install()

    expect(status.state).toBe('installed')
    expect(status.configPath).toBe(process.env.DEEPSEEK_CONFIG_PATH)
  })

  it('ignores legacy ~/.deepseek config when explicit paths are absent', async () => {
    delete process.env.CODEWHALE_CONFIG_PATH
    delete process.env.DEEPSEEK_CONFIG_PATH
    mkdirSync(join(home, '.deepseek'), { recursive: true })
    const legacyConfigPath = join(home, '.deepseek', 'config.toml')
    const legacyConfig = 'model = "deepseek-chat"\n'
    writeFileSync(legacyConfigPath, legacyConfig)

    const { CodeWhaleHookService } = await import('./hook-service')
    const status = new CodeWhaleHookService().install()

    expect(status.state).toBe('installed')
    expect(status.configPath).toBe(configPath())
    expect(readFileSync(legacyConfigPath, 'utf-8')).toBe(legacyConfig)
    expect(readFileSync(configPath(), 'utf-8')).toContain('[[hooks.hooks]]')
  })

  it('ignores CODEWHALE_HOME for hook config selection', async () => {
    delete process.env.CODEWHALE_CONFIG_PATH
    delete process.env.DEEPSEEK_CONFIG_PATH
    process.env.CODEWHALE_HOME = join(home, 'isolated-codewhale-home')

    const { CodeWhaleHookService } = await import('./hook-service')
    const status = new CodeWhaleHookService().install()

    expect(status.state).toBe('installed')
    expect(status.configPath).toBe(configPath())
    expect(existsSync(join(process.env.CODEWHALE_HOME, 'config.toml'))).toBe(false)
  })

  it('reports partial when some managed CodeWhale hook events are missing', async () => {
    const dir = join(home, '.codewhale')
    mkdirSync(dir, { recursive: true })
    const firstEvent = CODEWHALE_HOOK_EVENTS[0]
    writeFileSync(
      configPath(),
      applyManagedCodeWhaleHooks('', (event) =>
        event === firstEvent
          ? `run ${join(home, '.orca', 'agent-hooks', scriptFileName())}`
          : 'run user-hook'
      )
    )

    const { CodeWhaleHookService } = await import('./hook-service')
    const status = new CodeWhaleHookService().getStatus()

    expect(status.state).toBe('partial')
    expect(status.managedHooksPresent).toBe(true)
    expect(status.detail).toContain(CODEWHALE_HOOK_EVENTS[1])
  })

  it('stages Windows cmd env mirror fields through data-urlencode files', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const { CodeWhaleHookService } = await import('./hook-service')
      expect(new CodeWhaleHookService().install().state).toBe('installed')

      const script = readFileSync(scriptPath(), 'utf-8')
      const encodedFieldWriter = script.match(/-EncodedCommand (\S+)/)?.[1]
      expect(encodedFieldWriter).toBeDefined()
      const fieldWriter = Buffer.from(encodedFieldWriter!, 'base64').toString('utf16le')
      expect(fieldWriter).toContain("'hook_event_name' = 'ORCA_CODEWHALE_HOOK_EVENT'")
      expect(fieldWriter).toContain('Join-Path $env:ORCA_CODEWHALE_FORM_DIR "payload"')
      expect(script).toContain('hook_event_name@%ORCA_CODEWHALE_FORM_DIR%\\hook_event_name')
      expect(script).toContain('deepseekToolArgs@%ORCA_CODEWHALE_FORM_DIR%\\deepseekToolArgs')
      expect(script).toContain('payload@%ORCA_CODEWHALE_FORM_DIR%\\payload')
      expect(script).not.toContain('payload@-')
      expect(script).not.toContain('deepseekToolArgs=%DEEPSEEK_TOOL_ARGS%')
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it.skipIf(process.platform !== 'win32')(
    'posts Windows cmd form fields with quoted JSON and CJK values',
    async () => {
      const { CodeWhaleHookService } = await import('./hook-service')
      expect(new CodeWhaleHookService().install().state).toBe('installed')

      const deepseekToolArgs = JSON.stringify({
        command: 'printf "你好 & 世界"',
        path: 'C:\\Temp\\quoted path'
      })
      const deepseekMessage = '完成 "引用" & 数据'

      const received = new Promise<Record<string, string>>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null
        const server = createServer((req, res) => {
          const chunks: Buffer[] = []
          req.on('data', (chunk: Buffer) => chunks.push(chunk))
          req.on('end', () => {
            if (timer) {
              clearTimeout(timer)
            }
            res.writeHead(204)
            res.end()
            server.close()
            resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))))
          })
        })
        server.on('error', reject)
        server.listen(0, '127.0.0.1', () => {
          const address = server.address()
          if (!address || typeof address !== 'object') {
            reject(new Error('Could not bind test hook server'))
            return
          }
          const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${scriptPath()}"`], {
            env: {
              ...process.env,
              ORCA_AGENT_HOOK_ENDPOINT: '',
              ORCA_AGENT_HOOK_PORT: String(address.port),
              ORCA_AGENT_HOOK_TOKEN: 'token-1',
              ORCA_PANE_KEY: 'tab-1:11111111-1111-4111-8111-111111111111',
              ORCA_TAB_ID: 'tab-1',
              ORCA_WORKTREE_ID: 'wt-1',
              ORCA_AGENT_HOOK_ENV: 'production',
              ORCA_AGENT_HOOK_VERSION: '1',
              ORCA_CODEWHALE_HOOK_EVENT: 'tool_call_after',
              DEEPSEEK_TOOL_NAME: 'Shell "计划" & echo nope',
              DEEPSEEK_TOOL_ARGS: deepseekToolArgs,
              DEEPSEEK_MESSAGE: deepseekMessage
            },
            stdio: ['ignore', 'ignore', 'ignore']
          })
          timer = setTimeout(() => {
            child.kill()
            server.close()
            reject(new Error('Timed out waiting for Windows CodeWhale hook wrapper'))
          }, 10_000)
          child.on('error', (error) => {
            if (timer) {
              clearTimeout(timer)
            }
            server.close()
            reject(error)
          })
          child.on('close', (status) => {
            if (status === 0) {
              return
            }
            if (timer) {
              clearTimeout(timer)
            }
            server.close()
            reject(new Error(`Windows CodeWhale hook exited ${String(status)}`))
          })
        })
      })

      await expect(received).resolves.toMatchObject({
        hook_event_name: 'tool_call_after',
        payload: '{}',
        deepseekToolName: 'Shell "计划" & echo nope',
        deepseekToolArgs,
        deepseekMessage,
        env: 'production'
      })
    }
  )
})
