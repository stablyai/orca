import { randomUUID } from 'node:crypto'
import { matchesRexRootIdentity } from './rex-root-identity'
import { observePtyForeground } from '../../pty/process-retirement/pty-master-foreground-observation'
import {
  getStrictProcessTableSnapshot,
  withEvidenceBudget
} from '../../../shared/process-observation/tables/process-table-snapshot-reader'
import {
  collectDescendantsFromIndex,
  getProcessTableIndex
} from '../../../shared/process-observation/tables/process-table-index'
import { normalizePtyTty } from '../../pty/process-retirement/terminal-process-rows'
import { isShellProcess } from '../../../shared/agent-status/process/shell-process-detection'
import { executableName } from '../../daemon/pty-subprocess/spawn-file-child-processes'
import type { PtyProcessInspectionOptions } from '../pty/process-inspection'
import type {
  HostProcessInspection,
  PtyChildProcessVerdict
} from '../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import {
  unreadableArgvName,
  type ProcessTableRow
} from '../../../shared/process-observation/tables/process-table-snapshot'
import type { RexSessionStore } from './rex-session-store'
import { RexControl } from './rex-control'
import { rexTerminalProcess } from './rex-rpc-schema'
import { rexServerIdentity, verifyRexIdentity } from './rex-session-record'

export function judgeRexChildren(
  rows: readonly ProcessTableRow[],
  rootPid: number
): PtyChildProcessVerdict {
  const index = getProcessTableIndex(rows)
  const root = index.byPid.get(rootPid)
  const tty = normalizePtyTty(root?.tty ?? '')
  const name = root ? executableName(root.command) : ''
  if (
    !root ||
    !tty ||
    !name ||
    unreadableArgvName(root.command) !== null ||
    !isShellProcess(name) ||
    /[TZ]/.test(root.stat) ||
    !root.pgid ||
    root.pgid < 0 ||
    root.pgid !== root.tpgid
  ) {
    return 'unverifiable'
  }
  const descendants = collectDescendantsFromIndex(index, rootPid)
  if (descendants.some((row) => !row.stat.includes('Z'))) {
    return 'children'
  }
  // Reparented jobs on the same controlling terminal are not necessarily descendants.
  if (
    rows.some(
      (row) =>
        row.pid !== rootPid && normalizePtyTty(row.tty ?? '') === tty && !row.stat.includes('Z')
    )
  ) {
    return 'children'
  }
  return 'no-children'
}

export class RexProcessInspector {
  private readonly generation = randomUUID()
  private epoch = 0
  constructor(
    private readonly endpoint: string,
    private readonly records: RexSessionStore
  ) {}

  async inspect(id: string, opts?: PtyProcessInspectionOptions): Promise<HostProcessInspection> {
    const unknown: HostProcessInspection = {
      foregroundProcess: null,
      hasChildProcesses: true,
      childProcessEvidence: 'unverifiable'
    }
    const started = Date.now()
    try {
      const record = await this.records.read(id, opts?.expectedIncarnationId)
      await this.records.retirements.assertAvailable(record)
      if (
        record.adopted ||
        record.backend !== 'rex-local' ||
        !(await matchesRexRootIdentity(record))
      ) {
        return unknown
      }
      const ctl = await RexControl.connect(this.endpoint)
      try {
        const server = await ctl.call('server.status', {}, rexServerIdentity.parse)
        await ctl.call('session.attach', { session_id: record.sessionId })
        const read = () =>
          ctl.call(
            'com.superlogical.terminal.process',
            { session_id: record.sessionId, block_id: record.blockId, args: {} },
            rexTerminalProcess.parse
          )
        const before = await read()
        verifyRexIdentity(record, server, before.child?.pid)
        if (before.last_exit) {
          return unknown
        }
        const sample = await observePtyForeground({ pid: record.rootPid }, () => true)
        let children: PtyChildProcessVerdict = 'unverifiable'
        if (!opts?.foregroundOnly && sample.verdict === 'observed') {
          if (sample.foregroundKind === 'non-shell') {
            children = 'children'
          } else {
            if (record.interactiveShell) {
              const rows = await withEvidenceBudget(getStrictProcessTableSnapshot(true)).catch(
                () => null
              )
              if (rows) {
                children = judgeRexChildren(rows, record.rootPid)
              }
            }
          }
        }
        const after = await read()
        verifyRexIdentity(record, server, after.child?.pid)
        if (
          after.last_exit ||
          !before.foreground?.pid ||
          before.foreground.pid !== after.foreground?.pid ||
          !(await matchesRexRootIdentity(record)) ||
          Date.now() - started > 5_000
        ) {
          return unknown
        }
        await this.records.read(id, record.incarnationId)
        await this.records.retirements.assertAvailable(record)
        if (sample.verdict !== 'observed') {
          return unknown
        }
        if (children === 'no-children' && after.foreground?.pid !== record.rootPid) {
          children = 'unverifiable'
        }
        return {
          foregroundProcess: sample.processName,
          hasChildProcesses: children !== 'no-children',
          childProcessEvidence: children,
          foregroundObservation: {
            ...sample,
            ptyId: id,
            ptyIncarnationId: record.incarnationId,
            authorityGeneration: this.generation,
            observationEpoch: ++this.epoch,
            capturedAgeMs: Date.now() - started
          },
          ...(children === 'no-children' &&
          sample.foregroundKind === 'shell' &&
          after.foreground.pid === record.rootPid
            ? { idleShellProven: true as const }
            : {})
        }
      } finally {
        ctl.close()
      }
    } catch {
      return unknown
    }
  }
}
