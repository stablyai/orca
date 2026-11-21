import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'

import { buildHookProcessCapture, HOOK_PARENT_CAPTURE } from './hook-process-capture'
import { quotePosixShell } from '../../../../shared/shell/launch/shell-argument-quoting'
import { readAgentProcessIdentity } from '../../../../shared/agent-status/process/agent-process-presence'
import { probeAgentProcessPresence } from '../../../../shared/agent-status/process/agent-process-presence-probe'

describe('Claude outer hook process capture', () => {
  it.skipIf(process.platform === 'win32')(
    'reports the caller behind a forking outer sh -c, but never the parent of a non-shell caller',
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'orca-presence-unwrap-'))
      try {
        const scriptPath = join(home, 'antigravity-hook.sh')
        await writeFile(
          scriptPath,
          ['#!/bin/sh', ...buildHookProcessCapture(), 'printf "%s" "$orca_agent_process"'].join(
            '\n'
          ),
          { mode: 0o700 }
        )
        const command = `/bin/sh -c ${quotePosixShell(`${HOOK_PARENT_CAPTURE}/bin/sh ${quotePosixShell(scriptPath)}`)}`
        const env = { HOME: home, PATH: '/usr/bin:/bin', ORCA_PANE_KEY: 'presence-test-pane' }

        // `; exit $?` keeps the outer shell from exec'ing the command, as a forking sh does.
        const wrapped = await runProcess({
          program: '/bin/sh',
          args: ['-c', `${command}; exit $?`],
          env,
          timeoutMs: 5000
        })
        const identity = readAgentProcessIdentity(wrapped.stdout)
        expect(identity?.pid).toBe(process.pid)
        expect(await probeAgentProcessPresence(identity)).toBe('live')

        // A non-shell agent whose args quote the wrapper keeps its own PID.
        const direct = await runProcess({
          program: process.execPath,
          args: [
            '-e',
            `const out = require('node:child_process').spawnSync('/bin/sh', ['-c', process.argv[1]], { encoding: 'utf8' }).stdout
             process.stdout.write(JSON.stringify({ pid: process.pid, out }))`,
            command,
            '/bin/sh -c ORCA_HOOK_AGENT_PID=1'
          ],
          env,
          timeoutMs: 5000
        })
        const caller: { pid: number; out: string } = JSON.parse(direct.stdout)
        expect(readAgentProcessIdentity(caller.out)?.pid).toBe(caller.pid)
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    "reuses a Claude session's identity for tool events until its next lifecycle event re-reads it",
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'orca-presence-reuse-'))
      try {
        const scriptPath = join(home, 'claude-hook.sh')
        await writeFile(
          scriptPath,
          [
            '#!/bin/sh',
            'payload=$1',
            ...buildHookProcessCapture({ reuseForClaudeToolEvents: true }),
            'printf "%s" "$orca_agent_process"'
          ].join('\n'),
          { mode: 0o700 }
        )
        const endpointPath = join(home, 'endpoint.env')
        await writeFile(endpointPath, '')
        const capture = async (hookEventName: string, spacedPayload = false) => {
          const payload = JSON.stringify({ session_id: 'session-1', hook_event_name: hookEventName })
          const result = await runProcess({
            program: '/bin/sh',
            args: [
              '-c',
              `${HOOK_PARENT_CAPTURE}/bin/sh ${quotePosixShell(scriptPath)} "$1"`,
              'sh',
              spacedPayload ? payload.replaceAll('":"', '": "') : payload
            ],
            env: {
              HOME: home,
              PATH: '/usr/bin:/bin',
              ORCA_PANE_KEY: 'tab-1:pane-1',
              ORCA_AGENT_HOOK_ENDPOINT: endpointPath
            },
            timeoutMs: 5000
          })
          return readAgentProcessIdentity(result.stdout)
        }

        const live = await capture('SessionStart')
        expect(live?.pid).toBe(process.pid)
        expect(await probeAgentProcessPresence(live)).toBe('live')

        const recordPath = join(home, 'hook-metadata', 'agent-tab-1_pane-1')
        const stale = { pid: process.pid, platform: live?.platform, startTime: 'stale' }
        await writeFile(recordPath, `${process.pid} session-1 ${JSON.stringify(stale)}\n`)
        expect(await capture('PostToolUse')).toEqual(stale)
        expect(await capture('PostToolUse', true)).toEqual(stale)

        expect(await capture('UserPromptSubmit')).toEqual(live)
        expect(await capture('PreToolUse')).toEqual(live)
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    }
  )
})
