import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/userData' } }))

import { getManagedScript as getClaudeManagedScript } from '../claude/hook-service'
import { getManagedScript as getCursorManagedScript } from '../cursor/hook-script'

const CLAUDE_SCRIPT_OPTIONS = {
  skipWhenDevinImportsClaude: true,
  skipWhenGrokImportsClaude: true,
  skipWhenCursorImportsClaude: true
}
const CURSOR_ENV = { CURSOR_VERSION: '2026.10.16', CURSOR_PROJECT_DIR: '/work/project' }

async function runHook(script: string, hookEnv: NodeJS.ProcessEnv) {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    request.resume()
    request.on('end', () => response.end('{}'))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const dir = mkdtempSync(join(tmpdir(), 'orca-cursor-replay-'))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected a loopback port')
    }
    const windows = process.platform === 'win32'
    const scriptPath = join(dir, windows ? 'hook.cmd' : 'hook.sh')
    writeFileSync(scriptPath, script)
    const result = await runProcess({
      program: windows ? scriptPath : '/bin/sh',
      args: windows ? [] : [scriptPath],
      input: '{"hook_event_name":"Stop"}',
      env: {
        ...process.env,
        CURSOR_VERSION: '',
        CURSOR_PROJECT_DIR: '',
        GROK_HOOK_EVENT: '',
        DEVIN_SESSION_ID: '',
        CLAUDE_JOB_DIR: '',
        ORCA_AGENT_HOOK_ENDPOINT: '',
        ORCA_AGENT_HOOK_PORT: String(address.port),
        ORCA_AGENT_HOOK_TOKEN: 'test-token',
        ORCA_PANE_KEY: 'tab:leaf',
        ...hookEnv
      }
    })
    expect(result.code).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.stdout.replaceAll('\r\n', '\n')).toBe('{}\n')
    return requests
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('Cursor vendor hook replay guard', () => {
  it('drops imported Claude events while preserving the hook protocol response', async () => {
    expect(
      await runHook(getClaudeManagedScript('local', CLAUDE_SCRIPT_OPTIONS), CURSOR_ENV)
    ).toEqual([])
  })

  it.each([{}, { CURSOR_VERSION: CURSOR_ENV.CURSOR_VERSION }, { CURSOR_PROJECT_DIR: '/p' }])(
    'still delivers Claude hooks when only part of the Cursor environment is present: %j',
    async (env) => {
      expect(await runHook(getClaudeManagedScript('local', CLAUDE_SCRIPT_OPTIONS), env)).toEqual([
        '/hook/claude'
      ])
    }
  )

  it('keeps Cursor native hooks reporting in the same environment', async () => {
    expect(await runHook(getCursorManagedScript('local'), CURSOR_ENV)).toEqual(['/hook/cursor'])
  })

  it('does not suppress a hook service that did not opt in to the Claude import guard', async () => {
    expect(await runHook(getClaudeManagedScript('local'), CURSOR_ENV)).toEqual(['/hook/claude'])
  })
})
