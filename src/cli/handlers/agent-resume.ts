import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime/types'
import { hasUnsafeProviderSessionIdChars } from '../../shared/agent-session-resume'
import { spawnProcess } from '../../shared/child-process/run-process'
import {
  AGENT_RESUME_ARGV_ENV,
  AGENT_RESUME_COMMAND_ENV
} from '../../shared/agent-resume-launch-command'

const INTERNAL_ARG_ENV_PREFIX = 'ORCA_INTERNAL_AGENT_RESUME_ARG_'
const MAX_RESUME_ARG_COUNT = 16
const MAX_RESUME_VALUE_LENGTH = 32_768

export type AgentResumeEnvLaunch = {
  shell: string
  runnerContents: string
  env: NodeJS.ProcessEnv
}

function readResumeArgv(value: string | undefined): string[] | null {
  if (!value) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > MAX_RESUME_ARG_COUNT ||
    parsed.some(
      (arg) =>
        typeof arg !== 'string' ||
        arg.length === 0 ||
        arg.length > MAX_RESUME_VALUE_LENGTH ||
        hasUnsafeProviderSessionIdChars(arg) ||
        arg.includes('"') ||
        arg.endsWith('\\')
    )
  ) {
    return null
  }
  return parsed
}

export function resolveAgentResumeEnvLaunch(
  sourceEnv: NodeJS.ProcessEnv
): AgentResumeEnvLaunch | null {
  const baseCommand = sourceEnv[AGENT_RESUME_COMMAND_ENV]
  const resumeArgv = readResumeArgv(sourceEnv[AGENT_RESUME_ARGV_ENV])
  if (
    !baseCommand ||
    baseCommand.length > MAX_RESUME_VALUE_LENGTH ||
    hasUnsafeProviderSessionIdChars(baseCommand) ||
    !resumeArgv
  ) {
    return null
  }
  const env = { ...sourceEnv }
  delete env[AGENT_RESUME_COMMAND_ENV]
  delete env[AGENT_RESUME_ARGV_ENV]
  for (const key of Object.keys(env)) {
    if (key.startsWith(INTERNAL_ARG_ENV_PREFIX)) {
      delete env[key]
    }
  }
  const internalKeys: string[] = []
  const references = resumeArgv.map((value, index) => {
    const key = `${INTERNAL_ARG_ENV_PREFIX}${index}`
    internalKeys.push(key)
    env[key] = value
    return `"%${key}%"`
  })
  const clearInternalEnv = internalKeys.map((key) => `set "${key}="`).join(' & ')
  return {
    shell: sourceEnv.ComSpec?.trim() || 'cmd.exe',
    runnerContents: [
      '@echo off',
      'setlocal DisableDelayedExpansion',
      `${clearInternalEnv} & ${baseCommand} ${references.join(' ')}`
    ].join('\r\n'),
    env
  }
}

async function runAgentResumeEnv(): Promise<number> {
  if (process.platform !== 'win32') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Agent resume environment launch is Windows-only'
    )
  }
  const launch = resolveAgentResumeEnvLaunch(process.env)
  if (!launch) {
    throw new RuntimeClientError('invalid_argument', 'Invalid agent resume environment')
  }
  const runnerDirectory = mkdtempSync(path.join(tmpdir(), 'orca-agent-resume-'))
  const runnerPath = path.join(runnerDirectory, 'resume.cmd')
  writeFileSync(runnerPath, launch.runnerContents, 'utf8')
  try {
    return await new Promise((resolve, reject) => {
      const child = spawnProcess({
        program: launch.shell,
        args: ['/d', '/v:off', '/c', runnerPath],
        stdio: 'inherit',
        env: launch.env
      })
      child.once('error', reject)
      child.once('exit', (code) => resolve(typeof code === 'number' ? code : 1))
    })
  } finally {
    rmSync(runnerDirectory, { recursive: true, force: true })
  }
}

export const AGENT_RESUME_HANDLERS: Record<string, CommandHandler> = {
  'agent resume-env': async () => {
    process.exitCode = await runAgentResumeEnv()
  }
}
