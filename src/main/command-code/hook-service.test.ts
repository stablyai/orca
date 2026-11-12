import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { spawnProcess } from '@orca/process-host'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

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

  const itPosix = process.platform === 'win32' ? it.skip : it

  itPosix(
    'stops identity recovery at a background ancestor even when the hook env is scrubbed',
    async () => {
      new CommandCodeHookService().install()
      const requests: string[] = []
      const server = createServer((req, res) => {
        let body = ''
        req.setEncoding('utf8')
        req.on('data', (chunk) => (body += chunk))
        req.on('end', () => {
          requests.push(new URLSearchParams(body).get('paneKey') ?? '')
          res.writeHead(204).end()
        })
      })
      const ancestor = join(homeDir, 'ancestor.cjs')
      writeFileSync(
        ancestor,
        `const { spawn } = require('node:child_process')
const [hook, disabled, stage] = process.argv.slice(2)
const env = { PATH: process.env.PATH, HOME: process.env.HOME }
const child = stage === 'ancestor'
  ? spawn(process.execPath, [__filename, hook, disabled, 'background'], {
      env: { ...env, ORCA_AGENT_HOOKS_DISABLED: disabled },
      stdio: ['ignore', 'inherit', 'inherit']
    })
  : spawn('/bin/sh', [hook], { env, stdio: ['pipe', 'inherit', 'inherit'] })
if (stage !== 'ancestor') child.stdin.end(JSON.stringify({ hook_event_name: 'Stop' }))
child.on('error', error => { throw error })
child.on('close', code => { process.exitCode = code ?? 1 })
`
      )
      try {
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const address = server.address() as AddressInfo
        const run = async (disabled: string) => {
          const child = spawnProcess({
            program: process.execPath,
            args: [
              ancestor,
              join(homeDir, '.orca', 'agent-hooks', 'command-code-hook.sh'),
              disabled,
              'ancestor'
            ],
            env: {
              ...process.env,
              HOME: homeDir,
              ORCA_AGENT_HOOKS_DISABLED: '0',
              ORCA_AGENT_HOOK_PORT: String(address.port),
              ORCA_AGENT_HOOK_TOKEN: 'test-token',
              ORCA_PANE_KEY: 'recovered-tab:leaf',
              ORCA_TAB_ID: 'recovered-tab',
              ORCA_WORKTREE_ID: 'folder-workspace',
              ORCA_AGENT_LAUNCH_TOKEN: 'parent-launch'
            },
            stdio: ['ignore', 'ignore', 'pipe']
          })
          let stderr = ''
          child.stderr?.on('data', (chunk) => (stderr += chunk))
          const code = await new Promise<number | null>((resolve, reject) => {
            child.on('error', reject)
            child.on('close', resolve)
          })
          expect(code, stderr).toBe(0)
        }
        await run('0')
        expect(requests).toEqual(['recovered-tab:leaf'])
        await run('1')
        expect(requests).toEqual(['recovered-tab:leaf'])
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
  )

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
        requests.push({
          body,
          token: req.headers['x-orca-agent-hook-token']
        })
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
})
