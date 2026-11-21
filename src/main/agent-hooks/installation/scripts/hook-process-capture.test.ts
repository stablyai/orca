import { chmod, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'

import { buildHookProcessCapture, HOOK_PARENT_CAPTURE } from './hook-process-capture'
import { buildPosixHookMetadataCacheLines } from './hook-post-command'
import { buildPosixClaudeDecisionModeLines } from '../../../claude/hooks/claude-hook-decision-script'
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

  it.skipIf(process.platform !== 'darwin')(
    'reuses the pane cache on tool events for the same agent and launch, and asks ps again on any other event',
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'orca-presence-cache-'))
      try {
        const scriptPath = join(home, 'claude-hook.sh')
        await writeFile(
          scriptPath,
          [
            '#!/bin/sh',
            'payload=$(cat)',
            ...buildPosixClaudeDecisionModeLines(),
            ...buildPosixHookMetadataCacheLines(),
            ...buildHookProcessCapture({ reuseOnToolEvents: true }),
            'printf "%s" "$orca_agent_process"',
            'printf "%s" "${LC_ALL-unset}" >&2'
          ].join('\n'),
          { mode: 0o700 }
        )
        const endpoint = join(home, 'endpoint.env')
        await writeFile(endpoint, '')
        await mkdir(join(home, 'hook-metadata'))
        const cacheFile = join(home, 'hook-metadata', 'pane-presence-test-pane')
        const seed = (token: string): Promise<void> =>
          writeFile(
            cacheFile,
            `header\n${process.pid} ${token.length}:${token} {"pid":${process.pid},"platform":"darwin","startTime":"cached"}\n`
          )
        let lcAllAfter = ''
        const run = async (payload: string, lcAll?: string): Promise<string | undefined> => {
          const result = await runProcess({
            program: '/bin/sh',
            args: ['-c', `${HOOK_PARENT_CAPTURE}/bin/sh ${quotePosixShell(scriptPath)}`],
            env: {
              HOME: home,
              PATH: '/usr/bin:/bin',
              ORCA_PANE_KEY: 'presence-test-pane',
              ORCA_AGENT_LAUNCH_TOKEN: 'launch-1',
              ORCA_AGENT_HOOK_ENDPOINT: endpoint,
              ...(lcAll === undefined ? {} : { LC_ALL: lcAll })
            },
            input: payload,
            timeoutMs: 5000
          })
          lcAllAfter = result.stderr
          // The decision lines answer `{}` first, as Claude Code requires.
          return readAgentProcessIdentity(result.stdout.split('\n').pop())?.startTime
        }

        const toolEvent = '{"hook_event_name": "PostToolUse", "tool_name": "Bash"}'
        await seed('launch-1')
        expect(await run(toolEvent)).toBe('cached')
        expect(lcAllAfter).toBe('unset')
        expect(await run(toolEvent, 'en_US.UTF-8')).toBe('cached')
        expect(lcAllAfter).toBe('en_US.UTF-8')
        const fresh = await run('{"hook_event_name":"SessionStart","agent_type":"tool_name"}')
        expect(fresh).not.toBe('cached')
        expect(
          await probeAgentProcessPresence({
            pid: process.pid,
            platform: 'darwin',
            startTime: fresh!
          })
        ).toBe('live')
        expect(await run(toolEvent)).toBe(fresh)
        // The pane's packed-header line survives the rewrite.
        expect((await readFile(cacheFile, 'utf8')).split('\n')[0]).toBe('header')

        await seed('launch-1')
        expect(
          await run('{"hook_event_name":"UserPromptSubmit","prompt":"say \\"tool_name\\": now"}')
        ).toBe(fresh)
        expect(await run(toolEvent)).toBe(fresh)

        await seed('launch-0')
        expect(await run(toolEvent)).toBe(fresh)

        // A refresh that cannot replace the record must not leave the old one reusable, or end the hook.
        const prompt = '{"hook_event_name":"UserPromptSubmit","prompt":"hi"}'
        await seed('launch-1')
        await chmod(join(home, 'hook-metadata'), 0o500)
        expect(await run(prompt)).toBe(fresh)
        expect(await run(toolEvent)).toBe(fresh)
        await seed('launch-1')
        await chmod(cacheFile, 0o400)
        expect(await run(prompt)).toBe(fresh)
        await chmod(cacheFile, 0o600)
        await chmod(join(home, 'hook-metadata'), 0o700)

        // Another live agent sharing the pane keeps its record instead of trading it on every event.
        const other = `${process.ppid} 8:launch-1 {"pid":${process.ppid},"platform":"darwin","startTime":"other"}`
        await writeFile(cacheFile, `header\n${other}\n`)
        expect(await run(prompt)).toBe(fresh)
        expect((await readFile(cacheFile, 'utf8')).split('\n')[1]).toBe(other)

        // Only the header cache creates the file.
        await rm(cacheFile)
        expect(await run(prompt)).toBe(fresh)
        await expect(readFile(cacheFile)).rejects.toThrow()
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    }
  )
})
