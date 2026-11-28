import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'

import { buildPosixHookSpoolLines } from './hook-stdin-contract'
import { readSpoolFile } from '../../../../shared/agent-hook-listener/transport/agent-hook-spool'

describe('POSIX hook spool record', () => {
  it.skipIf(process.platform === 'win32')(
    'writes one replayable line for line breaks, quotes and non-UTF-8 bytes in values and a multi-line payload',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'orca-spool-record-'))
      try {
        const endpoint = join(dir, 'endpoint.env')
        await writeFile(endpoint, '')
        const scriptPath = join(dir, 'hook.sh')
        await writeFile(
          scriptPath,
          [
            'payload=$(cat)',
            // Shell-set, so the value can hold a byte that is not UTF-8.
            `ORCA_TAB_ID=$(printf 't\\377"\\\\\\tx\\r')`,
            ...buildPosixHookSpoolLines('claude'),
            'spool_hook_event'
          ].join('\n')
        )
        const result = await runProcess({
          program: '/bin/sh',
          args: [scriptPath],
          env: {
            PATH: '/usr/bin:/bin',
            LC_ALL: 'en_US.UTF-8',
            ORCA_PANE_KEY: 'tab1:pa\nne\r',
            ORCA_WORKTREE_ID: 'w"\\x',
            ORCA_AGENT_HOOK_ENDPOINT: endpoint
          },
          input: '{\n  "hook_event_name": "Stop",\n  "msg": "a\\nb"\n}\n',
          timeoutMs: 5000
        })
        expect(result.code).toBe(0)
        const [file] = await readdir(join(dir, 'spool'))
        const { records } = readSpoolFile(join(dir, 'spool', file))
        expect(records).toHaveLength(1)
        expect(records[0]).toMatchObject({
          paneKey: 'tab1:pa ne ',
          tabId: 't�"\\ x ',
          worktreeId: 'w"\\x',
          source: 'claude',
          payload: { hook_event_name: 'Stop', msg: 'a\nb' }
        })
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  )
})
