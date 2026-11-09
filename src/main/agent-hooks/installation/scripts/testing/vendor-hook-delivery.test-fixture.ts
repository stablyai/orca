import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { expect } from 'vitest'

export async function runVendorHook(
  script: string,
  hookEnv: NodeJS.ProcessEnv,
  delivery: 'http' | 'spool' = 'http'
) {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    request.resume()
    request.on('end', () => response.end('{}'))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const dir = mkdtempSync(join(tmpdir(), 'orca-vendor-hook-'))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected a loopback port')
    }
    const windows = process.platform === 'win32'
    const scriptPath = join(dir, windows ? 'hook.cmd' : 'hook.sh')
    writeFileSync(scriptPath, script)
    const endpointPath = join(dir, windows ? 'endpoint.cmd' : 'endpoint.env')
    writeFileSync(endpointPath, '')
    const result = await runProcess({
      program: windows ? scriptPath : '/bin/sh',
      args: windows ? [] : [scriptPath],
      input: '{"hook_event_name":"Stop"}',
      timeoutMs: 5_000,
      env: {
        ...process.env,
        CURSOR_VERSION: '',
        CURSOR_PROJECT_DIR: '',
        GROK_HOOK_EVENT: '',
        DEVIN_SESSION_ID: '',
        DEVIN_PROJECT_DIR: '',
        ORCA_CURSOR_HOOK_RESPONSE: '',
        ORCA_AGENT_HOOK_TRANSPORT: '',
        CLAUDE_JOB_DIR: '',
        ORCA_AGENT_HOOK_ENDPOINT: endpointPath,
        ORCA_AGENT_HOOK_PORT: delivery === 'http' ? String(address.port) : '',
        ORCA_AGENT_HOOK_TOKEN: 'test-token',
        ORCA_PANE_KEY: 'tab:leaf',
        ...hookEnv
      }
    })
    expect(result.code).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.stdout.replaceAll('\r\n', '\n')).toBe('{}\n')
    const spoolDir = join(dir, 'spool')
    const spooled = existsSync(spoolDir)
      ? readdirSync(spoolDir).flatMap((file) =>
          readFileSync(join(spoolDir, file), 'utf8').split('\n').filter(Boolean)
        )
      : []
    return { requests, spooled }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
    rmSync(dir, { recursive: true, force: true })
  }
}
