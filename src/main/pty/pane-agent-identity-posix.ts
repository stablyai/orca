import { paneAgentStopLineageRoot } from './pane-agent-stop-release'
import { readFile, readdir } from 'node:fs/promises'
import { loadLibprocAddon } from '../../shared/libproc-addon'
import { formatLibprocStat, formatLstart } from '../../shared/libproc-ps-format'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import {
  buildProcessTableIndex,
  collectDescendantsFromIndex
} from '../../shared/process-table-index'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import { getSyntheticAgentTitleProfile } from '../../shared/synthetic-agent-title'
import { isShellProcess } from '../../shared/shell-process-detection'
import type { AgentProcessIdentity } from '../../shared/agent-process-presence'
import type { TerminalAgent } from '../../shared/terminal-agent'
import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import { chatAgentsShareConversations } from '../../shared/structured-agent-cli-conversation-adoption'
import type { PaneAgentStopCapture } from './pane-agent-stop'

export type PaneProcessRow = ProcessTableRow & { hookStartTime?: string }

export async function readPosixPaneProcessRows(): Promise<PaneProcessRow[]> {
  if (process.platform === 'darwin') {
    const rows = await loadLibprocAddon()?.readProcessTable({ command: true })
    if (!rows?.length) {
      throw new Error('process identity unavailable')
    }
    return rows.map((row) => ({
      pid: row.pid,
      ppid: row.ppid,
      pgid: row.pgid,
      tpgid: row.tpgid,
      tty: String(row.tdev),
      stat: formatLibprocStat(row),
      startTime: row.startUsec === undefined ? undefined : `${row.startSec}:${row.startUsec}`,
      hookStartTime: formatLstart(row.startSec, true),
      command: row.commandIncomplete ? '' : (row.command ?? '')
    }))
  }
  if (process.platform !== 'linux') {
    throw new Error('not POSIX')
  }
  const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  if (!boot) {
    throw new Error('boot identity unavailable')
  }
  const entries = await readdir('/proc')
  const rows = await Promise.all(
    entries
      .filter((name) => /^\d+$/.test(name))
      .map(async (name) => {
        try {
          const stat = await readFile(`/proc/${name}/stat`, 'utf8')
          const fields = stat
            .slice(stat.lastIndexOf(')') + 2)
            .trim()
            .split(/\s+/)
          if (!/^\d+$/.test(fields[19] ?? '')) {
            throw new Error('process identity unavailable')
          }
          const command = (await readFile(`/proc/${name}/cmdline`, 'utf8'))
            .replace(/\0/g, ' ')
            .trim()
          return {
            pid: Number(name),
            ppid: Number(fields[1]),
            pgid: Number(fields[2]),
            tpgid: Number(fields[5]),
            tty: fields[4],
            stat: fields[0] + (Number(fields[3]) === Number(name) ? 's' : ''),
            startTime: `${boot}:${fields[19]}`,
            hookStartTime: `${boot}:${fields[19]}`,
            command
          }
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            (error.code === 'ENOENT' || error.code === 'ESRCH')
          ) {
            return null
          }
          throw error
        }
      })
  )
  return rows.filter((row) => row !== null)
}

const executable = (row: ProcessTableRow) =>
  row.command.trim().replace(/^-/, '').split(/\s+/, 1)[0] ?? ''
export const samePaneProcess = (
  row: ProcessTableRow | undefined,
  identity: { pid: number; startTime: string }
): boolean =>
  row?.pid === identity.pid && row.startTime === identity.startTime && !row.stat.startsWith('Z')

export function posixPaneShell(
  rows: readonly ProcessTableRow[],
  rootPid: number
): ProcessTableRow | null {
  const index = buildProcessTableIndex(rows)
  const root = index.byPid.get(rootPid)
  const children = index.childrenByPpid.get(rootPid) ?? []
  const shell =
    root && executable(root) === '/usr/bin/login' && children.length === 1 ? children[0] : root
  if (shell && recognizeAgentProcessFromCommandLine(shell.command)) {
    throw agentSessionRefusalError('agent_session_operation_invalid', { reason: 'shellReplaced' })
  }
  return shell &&
    isShellProcess(executable(shell)) &&
    shell.startTime &&
    shell.tty &&
    shell.tty !== '0' &&
    shell.tty !== '-1'
    ? shell
    : null
}

export function paneHasNoRecognizedAgent(
  rows: readonly ProcessTableRow[],
  shellPid: number,
  excluding?: ReadonlySet<number>
): boolean {
  const index = buildProcessTableIndex(rows)
  return collectDescendantsFromIndex(index, shellPid, (row) => row.stat.includes('s')).every(
    (row) =>
      excluding?.has(row.pid) ||
      row.stat.startsWith('Z') ||
      (!!row.command && !recognizeAgentProcessFromCommandLine(row.command))
  )
}

export function capturePosixPaneAgent(
  rows: readonly PaneProcessRow[],
  rootPid: number,
  agentType: TerminalAgent,
  hookProcess?: AgentProcessIdentity
): PaneAgentStopCapture | null {
  const shell = posixPaneShell(rows, rootPid)
  if (!shell?.startTime || shell.pgid === undefined || !shell.tty) {
    throw new Error('shell identity unavailable')
  }
  const index = buildProcessTableIndex(rows)
  const descendants = collectDescendantsFromIndex(index, shell.pid)
  const recognized = descendants.filter((row) => recognizeAgentProcessFromCommandLine(row.command))
  const family = (row: ProcessTableRow) => {
    const name = recognizeAgentProcessFromCommandLine(row.command)?.agent
    return name ? (getSyntheticAgentTitleProfile(name)?.titleIdentityGroup ?? name) : null
  }
  const roots = recognized.filter(
    (candidate) =>
      !recognized.some(
        (parent) =>
          parent.pid !== candidate.pid &&
          family(parent) === family(candidate) &&
          collectDescendantsFromIndex(index, parent.pid).some(
            (child) => child.pid === candidate.pid
          )
      )
  )
  if (!roots.length) {
    return null
  }
  if (
    roots.length !== 1 ||
    !chatAgentsShareConversations(
      recognizeAgentProcessFromCommandLine(roots[0].command)?.agent ?? '',
      agentType
    )
  ) {
    throw agentSessionRefusalError('agent_session_operation_invalid', { reason: 'agentAmbiguous' })
  }
  const agent = roots[0]
  if (!agent.startTime || !agent.pgid || !agent.tty) {
    throw new Error('agent identity unavailable')
  }
  if (hookProcess) {
    const hooked = rows.find((row) => row.pid === hookProcess.pid)
    if (
      !hooked ||
      !chatAgentsShareConversations(
        recognizeAgentProcessFromCommandLine(hooked.command)?.agent ?? '',
        agentType
      ) ||
      !(
        hooked.pid === agent.pid ||
        collectDescendantsFromIndex(index, agent.pid).some((row) => row.pid === hooked.pid)
      ) ||
      hooked.hookStartTime?.replace(/\s+/g, ' ') !== hookProcess.startTime.replace(/\s+/g, ' ')
    ) {
      throw new Error('hook process changed')
    }
  }
  const stopRoot = paneAgentStopLineageRoot(rows, shell.pid, {
    pid: agent.pid,
    startTime: agent.startTime
  })
  const targets = [
    index.byPid.get(stopRoot.pid)!,
    ...collectDescendantsFromIndex(index, stopRoot.pid)
  ]
  if (
    targets.some((row) => !row.startTime) ||
    !paneHasNoRecognizedAgent(rows, shell.pid, new Set(targets.map((row) => row.pid)))
  ) {
    throw new Error('agent lineage unavailable')
  }
  return {
    shell: { pid: shell.pid, startTime: shell.startTime },
    agent: { pid: agent.pid, startTime: agent.startTime },
    stopRoot,
    targets: targets.map((target) => ({ pid: target.pid, startTime: target.startTime! })),
    agentType,
    agentTty: agent.tty,
    tty: shell.tty,
    agentPgid: agent.pgid,
    paused: targets.some((target) => /^[Tt]/.test(target.stat))
  }
}
