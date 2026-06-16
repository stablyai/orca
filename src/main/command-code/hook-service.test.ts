import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer } from 'http'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { AddressInfo } from 'net'

const { homedirMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>()
}))

vi.mock('os', async () => {
  const actual = (await vi.importActual('os')) as Record<string, unknown>
  return {
    ...actual,
    homedir: homedirMock
  }
})

import { CommandCodeHookService } from './hook-service'

describe('CommandCodeHookService', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-command-code-home-'))
    homedirMock.mockReturnValue(homeDir)
  })

  afterEach(() => {
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('installs the managed command for Command Code status events', () => {
    const status = new CommandCodeHookService().install()

    expect(status.state).toBe('installed')
    expect(status.managedHooksPresent).toBe(true)

    const config = JSON.parse(
      readFileSync(join(homeDir, '.commandcode', 'settings.json'), 'utf8')
    ) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>
    }
    expect(Object.keys(config.hooks).sort()).toEqual(['PostToolUse', 'PreToolUse', 'Stop'].sort())
    expect(config.hooks.PreToolUse[0].matcher).toBe('.*')
    expect(config.hooks.PostToolUse[0].matcher).toBe('.*')
    expect(config.hooks.Stop[0].matcher).toBeUndefined()
    expect(config.hooks.PreToolUse[0].hooks[0].command).toContain('command-code-hook')
    expect(config.hooks.PreToolUse[0].hooks[0].command).toContain(join(homeDir, '.orca'))
    if (process.platform === 'win32') {
      expect(config.hooks.PreToolUse[0].hooks[0].command).toContain('command-code-hook.cmd')
    } else {
      expect(config.hooks.PreToolUse[0].hooks[0].command).toMatch(/^if \[ -x /)
    }
  })

  it('installs a hook script that can recover the endpoint when Command Code strips token env', () => {
    new CommandCodeHookService().install()

    const scriptFileName =
      process.platform === 'win32' ? 'command-code-hook.cmd' : 'command-code-hook.sh'
    const script = readFileSync(join(homeDir, '.orca', 'agent-hooks', scriptFileName), 'utf8')

    if (process.platform === 'win32') {
      expect(script).toContain('sourceEndpointByPort')
      expect(script).toContain('orca-dev\\agent-hooks')
      expect(script).toContain('set ORCA_AGENT_HOOK_PORT=')
    } else {
      expect(script).toContain('Command Code strips TOKEN-like env vars')
      expect(script).toContain('Command Code sanitizes hook subprocess env')
      expect(script).toContain('__orca_read_ancestor_var')
      expect(script).toContain('__orca_fill_from_endpoint_file')
      expect(script).toContain('[ "$__orca_endpoint_port" != "$ORCA_AGENT_HOOK_PORT" ]')
      expect(script).toContain('ORCA_PANE_KEY')
      expect(script).toContain('orca-dev/agent-hooks')
      expect(script).toContain('endpoint_port=')
    }
  })

  const itPosix = process.platform === 'win32' ? it.skip : it

  itPosix('does not let stale endpoint files clobber recovered connection fields', async () => {
    new CommandCodeHookService().install()

    const staleEndpointPath = join(homeDir, 'stale-endpoint.env')
    writeFileSync(
      staleEndpointPath,
      [
        'ORCA_AGENT_HOOK_PORT=9',
        'ORCA_AGENT_HOOK_TOKEN=stale-token',
        'ORCA_AGENT_HOOK_ENV=development',
        'ORCA_AGENT_HOOK_VERSION=1',
        ''
      ].join('\n')
    )

    const requests: { body: string; token: string | string[] | undefined }[] = []
    const server = createServer((req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        requests.push({ body, token: req.headers['x-orca-agent-hook-token'] })
        res.statusCode = 204
        res.end()
      })
    })

    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const address = server.address() as AddressInfo
      const scriptPath = join(homeDir, '.orca', 'agent-hooks', 'command-code-hook.sh')
      const child = spawn('/bin/sh', [scriptPath], {
        env: {
          ...process.env,
          HOME: homeDir,
          ORCA_AGENT_HOOK_ENDPOINT: staleEndpointPath,
          ORCA_AGENT_HOOK_PORT: String(address.port),
          ORCA_AGENT_HOOK_TOKEN: 'current-token',
          ORCA_PANE_KEY: 'tab:leaf',
          ORCA_TAB_ID: 'tab',
          ORCA_WORKTREE_ID: 'worktree',
          ORCA_AGENT_HOOK_ENV: 'development',
          ORCA_AGENT_HOOK_VERSION: '1'
        },
        stdio: ['pipe', 'ignore', 'pipe']
      })
      child.stdin.end(JSON.stringify({ hook_event_name: 'Stop' }))

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        let stderr = ''
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk) => {
          stderr += chunk
        })
        child.on('error', reject)
        child.on('exit', (code) => {
          if (stderr.trim()) {
            reject(new Error(stderr))
          } else {
            resolve(code)
          }
        })
      })

      expect(exitCode).toBe(0)
      expect(requests).toHaveLength(1)
      expect(requests[0].token).toBe('current-token')
      expect(new URLSearchParams(requests[0].body).get('paneKey')).toBe('tab:leaf')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('reports partial when one managed event is missing', () => {
    const service = new CommandCodeHookService()
    service.install()

    const configPath = join(homeDir, '.commandcode', 'settings.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      hooks: Record<string, unknown>
    }
    delete config.hooks.Stop
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

    const status = service.getStatus()

    expect(status.state).toBe('partial')
    expect(status.managedHooksPresent).toBe(true)
    expect(status.detail).toBe('Managed hook missing for events: Stop')
  })
})
