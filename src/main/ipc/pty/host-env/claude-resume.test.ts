import { runProcess } from '@orca/process-host'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getPosixClaudeShellFunction } from '../../../../shared/claude-shell-function'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../../../shared/setup-agent-sequencing'
import { prepareClaudeSessionResumeConfig } from '../../../claude/claude-session-resume-config'
import { resolveClaudeResumeLaunch, type PrepareClaudeSessionResume } from './claude-resume'

let root: string
let original: string
let transcript: string
let pointer: string
let prepare: PrepareClaudeSessionResume
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-executed-store-'))
  original = join(root, "account 'one' $literal", '.claude')
  transcript = join(original, 'projects', 'project', 'transcript.jsonl')
  pointer = join(root, 'selected')
  await mkdir(join(original, 'projects', 'project'), { recursive: true })
  await writeFile(transcript, '{}\n')
  await writeFile(pointer, join(root, 'new-selected-account'))
  await writeFile(
    join(root, 'claude'),
    '#!/bin/sh\nprintf "%s\\n" "${CLAUDE_CONFIG_DIR-unset}" "$@"\n'
  )
  await chmod(join(root, 'claude'), 0o700)
  prepare = ({ providerSession, launchConfig }) =>
    prepareClaudeSessionResumeConfig({
      providerSession,
      launchConfig,
      accountHomes: [{ configDir: original, readPath: original }],
      userHome: root
    })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function launchArgs() {
  return {
    command: "claude '--resume' 'session-id'",
    env: {
      PATH: `${root}:/usr/bin:/bin`,
      HOME: root,
      CLAUDE_CONFIG_DIR: original,
      ORCA_CLAUDE_PROFILE_POINTER: pointer,
      ORCA_CLAUDE_USER_CONFIG_DIR: original,
      ORCA_CLAUDE_INJECTED_CONFIG_DIR: original
    },
    providerSession: { key: 'session_id' as const, id: 'session-id', transcriptPath: transcript },
    shell: 'posix' as const,
    target: { runtime: 'host' as const },
    prepare
  }
}

async function execute(command: string, env: Record<string, string>): Promise<string> {
  const result = await runProcess({
    program: '/bin/bash',
    args: ['--noprofile', '--norc', '-c', `${getPosixClaudeShellFunction()}\n${command}`],
    env,
    timeoutMs: 10_000
  })
  expect(result.code).toBe(0)
  return result.stdout
}

describe('Claude resume command host binding', () => {
  it.skipIf(process.platform === 'win32')(
    'binds verified HOME after shell rc changes it without mutating the parent shell',
    async () => {
      const args = launchArgs()
      await writeFile(join(root, 'claude'), '#!/bin/sh\nprintf "%s\\n" "$HOME"\n')
      const launch = await resolveClaudeResumeLaunch(args)
      const other = join(root, 'rc-home')
      const output = await execute(
        `export HOME='${other}'\n${launch.command}\nprintf 'parent:%s\\n' "$HOME"`,
        args.env
      )
      expect(output.split('\n')).toEqual([root, `parent:${other}`, ''])
    }
  )
  it.skipIf(process.platform === 'win32')(
    'executes the original store after the live account pointer changes',
    async () => {
      const args = launchArgs()
      const before = await execute(args.command, args.env)
      expect(before.split('\n')[0]).toBe(join(root, 'new-selected-account'))
      const launch = await resolveClaudeResumeLaunch(args)
      expect(launch.command).toBeDefined()
      const after = await execute(
        `${launch.command}\nprintf 'after:%s\\n' "$CLAUDE_CONFIG_DIR"`,
        args.env
      )
      expect(after.split('\n')).toEqual([
        original,
        '--resume',
        'session-id',
        `after:${original}`,
        ''
      ])
    }
  )

  it.skipIf(process.platform === 'win32')(
    'rewrites the command the setup gate evaluates',
    async () => {
      const args = launchArgs()
      const gate = 'eval "$ORCA_SEQUENCED_STARTUP_COMMAND"'
      const launch = await resolveClaudeResumeLaunch({
        ...args,
        command: gate,
        env: { ...args.env, [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: args.command }
      })
      expect(launch.command).toBe(gate)
      expect(launch.env).toBeDefined()
      const output = await execute(gate, launch.env ?? {})
      expect(output.split('\n')).toEqual([original, '--resume', 'session-id', ''])
    }
  )

  it.skipIf(process.platform === 'win32')(
    'runs verified default with config unset despite both routing markers',
    async () => {
      const args = launchArgs()
      const defaultHome = join(root, '.claude')
      const defaultTranscript = join(defaultHome, 'projects', 'p', 'default.jsonl')
      await mkdir(join(defaultHome, 'projects', 'p'), { recursive: true })
      await writeFile(defaultTranscript, '{}\n')
      const launch = await resolveClaudeResumeLaunch({
        ...args,
        providerSession: { ...args.providerSession, transcriptPath: defaultTranscript },
        prepare: ({ providerSession }) =>
          prepareClaudeSessionResumeConfig({
            providerSession,
            accountHomes: [],
            userHome: root,
            admittedConfig: { kind: 'default', userHome: root }
          })
      })
      expect((await execute(launch.command ?? '', args.env)).split('\n')).toEqual([
        'unset',
        '--resume',
        'session-id',
        ''
      ])
    }
  )

  it('refuses an unavailable store without falling back to a fresh or selected-account launch', async () => {
    const args = launchArgs()
    await rm(transcript)
    await expect(resolveClaudeResumeLaunch(args)).rejects.toMatchObject({
      code: 'claude_resume_unavailable'
    })
  })

  it.each([
    'claude --resume session-id; touch /tmp/unwanted',
    'bash -c claude --resume session-id',
    'claude --resume another-id',
    'claude --resume session-id | cat',
    'claude --resume session-id --continue',
    'claude --resume session-id -c',
    '$HOME/bin/claude --resume session-id',
    '~/bin/claude --resume session-id',
    'claude --resume session-id --model "$MODEL"'
  ])('refuses an unmodelled or mismatched command: %s', async (command) => {
    await expect(resolveClaudeResumeLaunch({ ...launchArgs(), command })).rejects.toMatchObject({
      code: 'claude_resume_unavailable'
    })
  })

  it('refuses cmd until one-command environment restoration is supported', async () => {
    await expect(
      resolveClaudeResumeLaunch({ ...launchArgs(), shell: 'cmd' })
    ).rejects.toMatchObject({ code: 'claude_resume_unavailable' })
  })
})
