import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { describe, expect, it } from 'vitest'
import { getManagedScript } from './hook-script'
import { mergeAgentHookRequestHeaders } from '../../shared/agent-hook-listener/hook-envelope'
import { parseFormEncodedBody } from '../../shared/agent-hook-listener/request-body'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { buildSpoolHookBody } from '../../shared/agent-hook-spool'
import { isRecord } from '../../shared/agent-status-child-work-value-guards'

const paneKey = 'tab:11111111-1111-4111-8111-111111111111'
const payload = {
  hook_event_name: 'UserPromptSubmit',
  session_id: 'resume-config',
  prompt: 'hello'
}
const home = '/home/Original 用户'

function normalize(body: unknown) {
  return normalizeHookPayload(createHookListenerState(), 'claude', body, 'production')
}

describe.skipIf(process.platform === 'win32')('Claude executed environment capture', () => {
  it.each(['raw-json-v1', 'form', 'spool'])(
    'captures explicit/default store from the executed hook via %s',
    async (transport) => {
      const dir = await mkdtemp(join(tmpdir(), 'orca-claude-config-hook-'))
      const bodies: unknown[] = []
      const server = createServer((request, response) => {
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => chunks.push(chunk))
        request.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          bodies.push(
            request.headers['content-type'] === 'application/json'
              ? mergeAgentHookRequestHeaders(JSON.parse(text), request.headers)
              : parseFormEncodedBody(text)
          )
          response.writeHead(204).end()
        })
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      try {
        const address = server.address()
        if (!address || typeof address === 'string') {
          throw new Error('Missing loopback port')
        }
        const endpointDir = join(dir, 'agent-hooks')
        await mkdir(endpointDir)
        const endpoint = join(endpointDir, 'endpoint.env')
        await writeFile(endpoint, '')
        const script = join(dir, 'hook.sh')
        await writeFile(script, getManagedScript('posix'))
        for (const config of [
          undefined,
          '',
          "/project/用户 'quoted'/.claude",
          '/project/bad\npath'
        ]) {
          const { CLAUDE_CONFIG_DIR: _config, ...baseEnv } = process.env
          const result = await runProcess({
            program: '/bin/sh',
            args: [script],
            input: JSON.stringify(payload),
            timeoutMs: 5000,
            env: {
              ...baseEnv,
              HOME: home,
              ORCA_BACKGROUND_LAUNCH: '1',
              CLAUDE_JOB_DIR: '',
              ORCA_AGENT_HOOK_ENDPOINT: transport === 'spool' ? endpoint : '',
              ORCA_AGENT_HOOK_PORT: transport === 'spool' ? '' : String(address.port),
              ORCA_AGENT_HOOK_TOKEN: 'test-token',
              ORCA_AGENT_HOOK_ENV: 'production',
              ORCA_AGENT_HOOK_VERSION: '1',
              ORCA_AGENT_HOOK_TRANSPORT: transport,
              ORCA_PANE_KEY: paneKey,
              ORCA_TAB_ID: 'tab',
              ORCA_AGENT_LAUNCH_TOKEN: 'generation',
              ...(config !== undefined ? { CLAUDE_CONFIG_DIR: config } : {})
            }
          })
          expect(result.code).toBe(0)
          expect(result.timedOut).toBe(false)
          let body = bodies.at(-1)
          if (transport === 'spool') {
            const files = await readdir(join(endpointDir, 'spool'))
            const lines = (await readFile(join(endpointDir, 'spool', files[0]!), 'utf8'))
              .trim()
              .split('\n')
            const record: unknown = JSON.parse(lines.at(-1)!)
            if (!isRecord(record)) {
              throw new Error('Invalid spool record')
            }
            body = buildSpoolHookBody({
              ...record,
              paneKey,
              source: 'claude',
              payload,
              receivedAt: 1
            })
          }
          const event = normalize(body)
          expect(event?.providerSession?.id).toBe('resume-config')
          expect(event?.providerSession?.claudeConfig).toEqual(
            config?.includes('\n')
              ? undefined
              : config
                ? { kind: 'explicit', value: config, userHome: home }
                : { kind: 'default', userHome: home }
          )
          expect(event?.providerSession?.claudeConfigOrigin).toBeUndefined()
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(dir, { recursive: true, force: true })
      }
    }
  )

  it('ignores provider-payload store claims and non-Claude envelope claims', () => {
    const claimed = { kind: 'explicit', value: '/attacker', userHome: home }
    const body = {
      paneKey,
      claudeConfigKind: 'explicit',
      claudeConfigDir: '/actual',
      claudeUserHome: home,
      payload: { ...payload, claudeConfig: claimed, claudeConfigDir: '/attacker' }
    }
    expect(normalize(body)?.providerSession?.claudeConfig).toEqual({
      kind: 'explicit',
      value: '/actual',
      userHome: home
    })
    expect(
      normalize({ ...body, claudeConfigKind: 'default' })?.providerSession?.claudeConfig
    ).toBeUndefined()
    expect(
      normalize({ paneKey, payload: body.payload })?.providerSession?.claudeConfig
    ).toBeUndefined()
    expect(
      normalizeHookPayload(createHookListenerState(), 'codex', body, 'production')?.providerSession
        ?.claudeConfig
    ).toBeUndefined()
  })
})
