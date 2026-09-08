// src/relay/ssh-outbound-git-provider.ts
// TASK-AG-EVM-007/SOL-AG-EVM-003 §2c: runs `git` on a hidden target — a host
// this agent dialed OUT to (TASK-AG-EVM-005), registered in
// `hiddenTargetRegistry` (TASK-AG-EVM-006) — via ssh2's exec() on the dialed
// OutboundSshSession. Mirrors ssh-git-response-stream-reader.ts's
// architecture only (both "eventually run git over SSH"), not its code —
// that module reads a channel Orca opened INTO this agent (inbound); this
// one reads a channel this agent opened OUT (outbound), per SOL-AG-EVM-003
// §2c's explicit note not to reuse inbound-channel code.
//
// RPC method name (confirm against backend-go's TASK-BE-EVM-015 before
// relying on this from the backend side): `git.statusViaHiddenTarget` — see
// agent-rpc-dispatch-misc.ts's case.
import { lookupHiddenTargetSession } from './ssh-outbound-filesystem-provider'
import type { OutboundSshSession } from './ssh-outbound-client'

export type GitStatusViaHiddenTargetParams = { hiddenTargetId: string; repoPath: string }

export function validateGitStatusViaHiddenTargetParams(
  params: unknown
): GitStatusViaHiddenTargetParams {
  const p = (params ?? {}) as Record<string, unknown>
  const hiddenTargetId = p.hiddenTargetId
  const repoPath = p.repoPath
  if (typeof hiddenTargetId !== 'string' || hiddenTargetId.length === 0) {
    throw new Error('git.statusViaHiddenTarget: missing required param "hiddenTargetId"')
  }
  if (typeof repoPath !== 'string' || repoPath.length === 0) {
    throw new Error('git.statusViaHiddenTarget: missing required param "repoPath"')
  }
  return { hiddenTargetId, repoPath }
}

export type HiddenTargetGitFileStatus = {
  path: string
  indexStatus: string
  worktreeStatus: string
}

export type HiddenTargetGitStatusResult = {
  branch: string | null
  ahead: number
  behind: number
  files: HiddenTargetGitFileStatus[]
}

// Single-quotes `path` for use inside a remote shell command, escaping any
// embedded single quote the POSIX-shell way ('\'' — close quote, escaped
// quote, reopen quote). `repoPath` reaches this from an RPC param, so it
// must never be interpolated into the remote command unquoted.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function execOnHiddenTarget(
  session: OutboundSshSession,
  command: string
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    session.client.exec(command, (err, channel) => {
      if (err) {
        reject(err)
        return
      }
      let stdout = ''
      let stderr = ''
      let exitCode: number | null = null
      channel.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      channel.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      channel.on('exit', (code: number | null) => {
        exitCode = code
      })
      channel.on('close', () => {
        resolve({ stdout, stderr, exitCode })
      })
      channel.on('error', (execErr: Error) => reject(execErr))
    })
  })
}

// Parses `git status --porcelain=v1 -b` output. Format:
//   ## branch...upstream [ahead N, behind M]
//   XY path
function parsePorcelainStatus(stdout: string): HiddenTargetGitStatusResult {
  const lines = stdout.split('\n').filter((line) => line.length > 0)
  let branch: string | null = null
  let ahead = 0
  let behind = 0
  const files: HiddenTargetGitFileStatus[] = []

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const header = line.slice(3)
      const branchMatch = /^([^.\s]+)/.exec(header)
      branch = branchMatch ? branchMatch[1] : null
      const aheadMatch = /ahead (\d+)/.exec(header)
      const behindMatch = /behind (\d+)/.exec(header)
      ahead = aheadMatch ? Number(aheadMatch[1]) : 0
      behind = behindMatch ? Number(behindMatch[1]) : 0
      continue
    }
    const indexStatus = line[0] ?? ' '
    const worktreeStatus = line[1] ?? ' '
    const path = line.slice(3)
    files.push({ path, indexStatus, worktreeStatus })
  }

  return { branch, ahead, behind, files }
}

export async function gitStatusViaHiddenTarget(
  params: GitStatusViaHiddenTargetParams
): Promise<HiddenTargetGitStatusResult> {
  const session = lookupHiddenTargetSession(params.hiddenTargetId)
  const command = `git -C ${shellQuote(params.repoPath)} status --porcelain=v1 -b`
  const result = await execOnHiddenTarget(session, command)
  if (result.exitCode !== 0) {
    throw new Error(
      `git.statusViaHiddenTarget: "git status" exited ${result.exitCode}: ${result.stderr.slice(-2000)}`
    )
  }
  return parsePorcelainStatus(result.stdout)
}
