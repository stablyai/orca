import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { wrapRuntimeHomeHookCommand } from '../commands/runtime-home-hook-command'
import { buildHookProcessCapture, HOOK_PARENT_CAPTURE } from './hook-process-capture'
import { quotePosixShell } from '../../../../shared/shell/launch/shell-argument-quoting'
import { readAgentProcessIdentity } from '../../../../shared/agent-status/process/agent-process-presence'
import { probeAgentProcessPresence } from '../../../../shared/agent-status/process/agent-process-presence-probe'

describe('Claude outer hook process capture', () => {
  it.skipIf(process.platform === 'win32').each([undefined, 'Asia/Tokyo'])(
    'captures the parent before the managed script shell, under an empty environment (TZ=%s)',
    async (timeZone) => {
      const home = await mkdtemp(join(tmpdir(), 'orca-presence-hook-'))
      try {
        const dir = join(home, '.orca', 'agent-hooks')
        await mkdir(dir, { recursive: true })
        await writeFile(
          join(dir, 'claude-hook.sh'),
          ['#!/bin/sh', ...buildHookProcessCapture(), 'printf "%s" "$orca_agent_process"'].join(
            '\n'
          ),
          { mode: 0o700 }
        )
        const result = await runProcess({
          program: '/usr/bin/env',
          args: [
            '-i',
            `HOME=${home}`,
            'PATH=/usr/bin:/bin',
            'ORCA_PANE_KEY=presence-test-pane',
            // Agent timezone differences must not change process identity.
            ...(timeZone ? [`TZ=${timeZone}`] : []),
            '/bin/sh',
            '-c',
            wrapRuntimeHomeHookCommand('claude-hook')
          ],
          timeoutMs: 5000
        })
        expect(result.code).toBe(0)
        const identity = readAgentProcessIdentity(result.stdout)
        expect(identity?.pid).toBe(process.pid)
        expect(await probeAgentProcessPresence(identity)).toBe('live')
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    }
  )

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
})
