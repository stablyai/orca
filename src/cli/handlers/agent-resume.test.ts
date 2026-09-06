import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AGENT_RESUME_ARGV_ENV,
  AGENT_RESUME_COMMAND_ENV
} from '../../shared/agent-resume-launch-command'
import { resolveAgentResumeEnvLaunch } from './agent-resume'

describe('agent resume environment launcher', () => {
  it('keeps resume values out of the cmd command line', () => {
    const resumeArgv = [
      '--session',
      "C:\\Program Files (x86)\\100% real!\\O'Malley & Sons\\x.jsonl"
    ]
    const launch = resolveAgentResumeEnvLaunch({
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      [AGENT_RESUME_COMMAND_ENV]: '%LOCALAPPDATA%\\Programs\\omo.cmd',
      [AGENT_RESUME_ARGV_ENV]: JSON.stringify(resumeArgv)
    })

    expect(launch?.runnerContents).toContain(
      '%LOCALAPPDATA%\\Programs\\omo.cmd "%ORCA_INTERNAL_AGENT_RESUME_ARG_0%" "%ORCA_INTERNAL_AGENT_RESUME_ARG_1%"'
    )
    expect(launch?.runnerContents).not.toContain(resumeArgv[1])
    expect(launch?.env.ORCA_INTERNAL_AGENT_RESUME_ARG_1).toBe(resumeArgv[1])
    expect(launch?.env).not.toHaveProperty(AGENT_RESUME_COMMAND_ENV)
    expect(launch?.env).not.toHaveProperty(AGENT_RESUME_ARGV_ENV)
  })

  it('rejects malformed environment payloads', () => {
    for (const resumeArgv of [
      ['--session', 'session\nwhoami'],
      ['--session', 'session" & whoami'],
      ['--session', 'C:\\trailing\\']
    ]) {
      expect(
        resolveAgentResumeEnvLaunch({
          [AGENT_RESUME_COMMAND_ENV]: 'omo',
          [AGENT_RESUME_ARGV_ENV]: JSON.stringify(resumeArgv)
        })
      ).toBeNull()
    }
  })

  const itWindows = process.platform === 'win32' ? it : it.skip
  itWindows('round-trips legal path characters through an actual npm cmd shim', () => {
    const fixtureDir = mkdtempSync(path.join(tmpdir(), 'orca-agent-resume-'))
    const probePath = path.join(fixtureDir, 'probe.cjs')
    const shimPath = path.join(fixtureDir, 'omo.cmd')
    const transcriptPath = "C:\\Program Files (x86)\\100% real!\\O'Malley & Sons\\session.jsonl"
    try {
      writeFileSync(probePath, 'console.log(JSON.stringify(process.argv.slice(2)))\n', 'utf8')
      writeFileSync(shimPath, '@echo off\r\nnode "%~dp0probe.cjs" %*\r\n', 'utf8')
      const launch = resolveAgentResumeEnvLaunch({
        ...process.env,
        [AGENT_RESUME_COMMAND_ENV]: `"${shimPath}"`,
        [AGENT_RESUME_ARGV_ENV]: JSON.stringify(['--session', transcriptPath])
      })
      expect(launch).not.toBeNull()
      if (!launch) {
        throw new Error('Expected a Windows resume launch.')
      }
      const runnerPath = path.join(fixtureDir, 'resume.cmd')
      writeFileSync(runnerPath, launch.runnerContents, 'utf8')
      const output = execFileSync(launch.shell, ['/d', '/v:off', '/c', runnerPath], {
        env: launch.env,
        encoding: 'utf8'
      })
      expect(JSON.parse(output.trim())).toEqual(['--session', transcriptPath])
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true })
    }
  })
})
