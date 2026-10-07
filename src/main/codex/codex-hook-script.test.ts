import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { getManagedScript } from './codex-hook-script'

describe.skipIf(process.platform !== 'win32')('Windows Codex hook stdout', () => {
  it.each([false, true])('returns one JSON object with Orca context=%s', async (hasContext) => {
    const root = mkdtempSync(join(tmpdir(), 'codex-hook-json-'))
    try {
      const script = join(root, 'hook.cmd')
      const endpoint = join(root, 'endpoint.cmd')
      writeFileSync(script, getManagedScript())
      writeFileSync(endpoint, '@echo endpoint diagnostics\r\n')
      const result = await runProcess({
        program: script,
        args: [],
        cwd: root,
        input: JSON.stringify({ hook_event_name: 'Stop' }),
        env: {
          ...process.env,
          ORCA_AGENT_HOOK_ENDPOINT: endpoint,
          ORCA_AGENT_HOOK_PORT: hasContext ? '1' : '',
          ORCA_AGENT_HOOK_TOKEN: hasContext ? 'fixture' : '',
          ORCA_PANE_KEY: hasContext ? 'fixture' : ''
        },
        timeoutMs: 10_000
      })
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({})
      expect(result.stdout.trim()).toBe('{}')
      expect(result.stderr).toBe('')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
