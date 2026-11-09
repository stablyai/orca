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

  it.skipIf(process.platform === 'win32').each([undefined, 'darwin'])(
    'unwraps an outer sh -c wrapper without unwrapping non-shell callers (OSTYPE=%s)',
    async (osType) => {
      const home = await mkdtemp(join(tmpdir(), 'orca-presence-unwrap-'))
      try {
        const dir = join(home, '.orca', 'agent-hooks')
        await mkdir(dir, { recursive: true })
        const scriptPath = join(dir, 'antigravity-hook.sh')
        await writeFile(
          scriptPath,
          ['#!/bin/sh', ...buildHookProcessCapture(), 'printf "%s" "$orca_agent_process"'].join(
            '\n'
          ),
          { mode: 0o700 }
        )
        const wrappedCommand = `/bin/sh -c ${quotePosixShell(`${HOOK_PARENT_CAPTURE}/bin/sh ${quotePosixShell(scriptPath)}`)}`
        const wrappedResult = await runProcess({
          program: '/usr/bin/env',
          args: [
            '-i',
            `HOME=${home}`,
            'PATH=/usr/bin:/bin',
            'ORCA_PANE_KEY=presence-test-pane',
            ...(osType ? [`OSTYPE=${osType}`] : []),
            '/bin/sh',
            '-c',
            `${wrappedCommand}; exit $?`
          ],
          timeoutMs: 5000
        })
        expect(wrappedResult.code).toBe(0)
        const wrappedIdentity = readAgentProcessIdentity(wrappedResult.stdout)
        expect(wrappedIdentity?.pid).toBe(process.pid)
        if (osType === 'darwin') {
          expect(wrappedIdentity?.platform).toBe('darwin')
        }

        // A non-shell caller whose own argv contains ORCA_HOOK_AGENT_PID= must not be unwrapped to its parent.
        const directNonShellResult = await runProcess({
          program: process.execPath,
          args: [
            '-e',
            `const { spawnSync } = require('node:child_process');
             const res = spawnSync('/bin/sh', ['-c', ${JSON.stringify(wrappedCommand)}], {
               env: {
                 HOME: ${JSON.stringify(home)},
                 PATH: '/usr/bin:/bin',
                 ORCA_PANE_KEY: 'presence-test-pane',
                 ...(process.env.OSTYPE ? { OSTYPE: process.env.OSTYPE } : {})
               },
               encoding: 'utf8'
             });
             process.stdout.write(JSON.stringify({ callerPid: process.pid, hookOut: res.stdout }));`,
            'ORCA_HOOK_AGENT_PID=prompt-argument'
          ],
          env: {
            HOME: home,
            PATH: '/usr/bin:/bin',
            ...(osType ? { OSTYPE: osType } : {})
          },
          timeoutMs: 5000
        })
        expect(directNonShellResult.code).toBe(0)
        const parsed: { callerPid: number; hookOut: string } = JSON.parse(
          directNonShellResult.stdout
        )
        expect(readAgentProcessIdentity(parsed.hookOut)?.pid).toBe(parsed.callerPid)
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    }
  )
})
