import { emitPtyListeners, createPtyExitPayload } from './daemon-pty-listener-emission'
import { basename } from 'node:path'
import { existsSync } from 'node:fs'
import {
  isAgentSessionOwnerBinding,
  type AgentSessionOwnerBinding
} from '../../shared/agent-session-host-authority'
import { MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES } from '../../shared/claimed-agent-pty-owner'
import { cloneAgentSessionOwnerBinding } from '../../shared/claimed-agent-pty-owner-snapshot'
import { recordAuthenticatedInventory } from './daemon-audit-classifier'
import { isMissingWindowsNamedPipeError } from './daemon-endpoint-errors'
import { DaemonPtyProcessInspection } from './daemon-pty-process-inspection'
import { remainingDaemonRequestTimeoutMs } from './daemon-request-deadline'
import { parsePtySessionId } from '../../shared/pty-session-id-format'
import type { ListSessionsResult, SessionInfo } from './types'
import { PtyProcessListAdmission } from '../providers/pty-process-list-admission'
import type { PtyProcessInfo } from '../providers/pty-provider-contract'

export abstract class DaemonPtySessionInventory extends DaemonPtyProcessInspection {
  async listProcesses(opts?: { deadlineMs?: number }): Promise<PtyProcessInfo[]> {
    try {
      // Retry connect and inventory together; reconcile only once after both succeed.
      // Share the teardown deadline so handshake cannot consume a fresh budget before inventory.
      return await this.withDaemonRetry(async () => {
        await this.ensureConnected(opts?.deadlineMs)
        const inventory = this.ptyInventory.begin()
        try {
          const result = await this.client.request<ListSessionsResult>(
            'listSessions',
            undefined,
            remainingDaemonRequestTimeoutMs(opts?.deadlineMs)
          )
          const admission = new PtyProcessListAdmission()
          const processes: PtyProcessInfo[] = []
          const aliveSessionIds = new Map<string, string | undefined>()
          for (const session of result.sessions) {
            if (!session.isAlive) {
              continue
            }
            aliveSessionIds.set(session.sessionId, session.incarnationId)
            const { worktreeId } = parsePtySessionId(session.sessionId)
            processes.push(
              admission.admit({
                id: session.sessionId,
                ...(session.incarnationId ? { incarnationId: session.incarnationId } : {}),
                ...(session.pid ? { rootProcessId: session.pid } : {}),
                // Spawn cwd remains authoritative until the daemon reports live cwd.
                cwd: session.cwd ?? this.initialCwds.get(session.sessionId) ?? '',
                title: 'shell',
                ...(session.foregroundProcess
                  ? { foregroundProcess: session.foregroundProcess }
                  : {}),
                ...(worktreeId ? { worktreeId } : {}),
                ...(session.terminalHandle ? { terminalHandle: session.terminalHandle } : {}),
                ...(session.paneKey ? { paneKey: session.paneKey } : {}),
                ...(session.wslDistro !== undefined ? { wslDistro: session.wslDistro } : {}),
                ...(session.state === 'exiting' ? { exiting: true as const } : {}),
                ...this.validatedAgentSessionOwners(session.agentSessionOwners)
              })
            )
          }
          this.ptyInventory.commit(inventory, aliveSessionIds)
          this.publishAuditObservation(
            recordAuthenticatedInventory(this.auditContext, this.exactDaemonIncarnation)
          )
          return processes
        } finally {
          this.ptyInventory.end(inventory)
        }
      })
    } catch (error) {
      const missingAuthenticatedToken = this.isRetiredEndpointTokenMissing()
      const missingNamedPipe = isMissingWindowsNamedPipeError(error)
      this.observeAuditFailure(
        missingAuthenticatedToken
          ? 'token_missing_after_authenticated_disconnect'
          : 'inventory_failed',
        this.exactDaemonIncarnation,
        [
          ...(missingAuthenticatedToken ? (['token_file'] as const) : []),
          ...(missingNamedPipe ? (['windows_named_pipe'] as const) : [])
        ],
        missingNamedPipe ? 'windows_named_pipe_missing' : undefined
      )
      throw error
    }
  }

  protected validatedAgentSessionOwners(
    owners: unknown
  ): { agentSessionOwners: AgentSessionOwnerBinding[] } | Record<string, never> {
    if (owners === undefined) {
      return {}
    }
    if (
      !Array.isArray(owners) ||
      owners.length > MAX_CLAIMED_AGENT_PTY_OWNER_ENTRIES ||
      !owners.every((owner) => isAgentSessionOwnerBinding(owner) && owner.phase === 'live')
    ) {
      throw new Error('agent_session_ownership_unknown')
    }
    return owners.length > 0
      ? { agentSessionOwners: owners.map(cloneAgentSessionOwnerBinding) }
      : {}
  }

  // Manage Sessions needs details omitted from the generic listProcesses contract.
  async listSessions(): Promise<SessionInfo[]> {
    await this.ensureConnected()
    const result = await this.client.request<ListSessionsResult>('listSessions', undefined)
    return result.sessions
      .filter((s) => s.isAlive)
      .map((session) => ({
        ...session,
        ...this.validatedAgentSessionOwners(session.agentSessionOwners)
      }))
  }

  getActiveSessionIds(): string[] {
    return [...this.activeSessionIds]
  }

  // Daemon shutdown suppresses exit fanout; notify panes before teardown so they stop writing to dead PTYs.
  fanoutSyntheticExits(code: number, exit: { replacedByRestart?: true } = {}): void {
    const ids = [...this.activeSessionIds]
    this.activeSessionIds.clear()
    this.ptyInventory.reset()
    this.sessionsAwaitingDaemonRecovery.clear()
    this.writeRecoveryAttempted = false
    this.dirtySessionVersions.clear()
    this.lastFullCheckpointAt.clear()
    this.sessionsNeedingFullCheckpoint.clear()
    this.sessionsNeedingLiveCheckpoint.clear()
    this.sessionsNeedingContinuityCheckpoint.clear()
    this.overlayDeadlineWarnedSessionIds.clear()
    this.periodicDeadlineWarnedSessionIds.clear()
    this.nonFinalAdmissionDeniedSessionIds.clear()
    this.pausedProducerSessionIds.clear()
    this.producerResumesOwedOnReconnect.clear()
    this.stopCheckpointTimer()
    for (const id of ids) {
      this.coldRestoreCache.delete(id)
      // Match natural exit listeners: synthetic fanout preserves thrown errors.
      emitPtyListeners(this.exitListeners, (listener) =>
        listener(
          createPtyExitPayload(id, {
            code,
            incarnationId: this.sessionIncarnations.get(id),
            ...exit
          })
        )
      )
      this.sessionIncarnations.delete(id)
    }
  }

  async getDefaultShell(): Promise<string> {
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'powershell.exe'
    }
    return process.env.SHELL || '/bin/zsh'
  }

  async getProfiles(): Promise<{ name: string; path: string }[]> {
    if (process.platform === 'win32') {
      return [
        { name: 'PowerShell', path: 'powershell.exe' },
        { name: 'Command Prompt', path: 'cmd.exe' }
      ]
    }
    const shells = ['/bin/zsh', '/bin/bash', '/bin/sh']
    return shells.filter((s) => existsSync(s)).map((s) => ({ name: basename(s), path: s }))
  }
}
