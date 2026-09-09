import { isShellProcess } from '../../shared/agent-detection'
import { DaemonPtyBufferSnapshots } from './daemon-pty-buffer-snapshots'
import {
  COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION,
  GET_FOREGROUND_PROCESS_PROTOCOL_VERSION
} from './types'
import type { PtyProcessInspection } from '../providers/pty-process-inspection'
import { clientOnlyUnverifiableInspection } from '../../shared/terminal-process-inspection'

export abstract class DaemonPtyProcessInspection extends DaemonPtyBufferSnapshots {
  // Why: daemon-backed PTYs can host long-lived agents while detached; cleanup prompts must not treat them as idle shells.
  protected hasChildProcessesFromForeground(foregroundProcess: string | null): boolean {
    return foregroundProcess !== null && !isShellProcess(foregroundProcess)
  }

  async hasChildProcesses(id: string): Promise<boolean> {
    if (this.protocolVersion < GET_FOREGROUND_PROCESS_PROTOCOL_VERSION) {
      return true
    }
    return this.hasChildProcessesFromForeground(await this.getForegroundProcess(id))
  }

  async inspectProcess(
    id: string,
    options?: { expectedIncarnationId?: string; steadyState?: boolean }
  ): Promise<PtyProcessInspection> {
    if (this.protocolVersion < GET_FOREGROUND_PROCESS_PROTOCOL_VERSION) {
      return clientOnlyUnverifiableInspection('old_host')
    }
    if (this.protocolVersion < COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION) {
      // Why: pre-v27 daemons survive an in-place app update; compose the inspection client-side from the
      // one call they do support instead of throwing, or completion detection stays dead until recreate.
      // Requests directly (not via getForegroundProcess) so a dead socket still rejects rather than
      // reading as an idle foreground and dispatching a false completion.
      const { foregroundProcess } = await this.client.request<{
        foregroundProcess: string | null
      }>('getForegroundProcess', { sessionId: id })
      return {
        foregroundProcess,
        hasChildProcesses: this.hasChildProcessesFromForeground(foregroundProcess)
      }
    }
    return this.client.request<PtyProcessInspection>('inspectProcess', {
      sessionId: id,
      ...(options?.expectedIncarnationId
        ? { expectedIncarnationId: options.expectedIncarnationId }
        : {}),
      // Additive: an older daemon ignores it and pays for the full capture.
      ...(options?.steadyState === true ? { steadyState: true } : {})
    })
  }

  async getForegroundProcess(id: string): Promise<string | null> {
    if (this.protocolVersion < GET_FOREGROUND_PROCESS_PROTOCOL_VERSION) {
      return null
    }
    try {
      const result = await this.client.request<{ foregroundProcess: string | null }>(
        'getForegroundProcess',
        { sessionId: id }
      )
      return result.foregroundProcess
    } catch {
      return null
    }
  }

  async confirmForegroundProcess(id: string): Promise<string | null> {
    try {
      const result = await this.client.request<{ foregroundProcess: string | null }>(
        'confirmForegroundProcess',
        { sessionId: id }
      )
      return result.foregroundProcess
    } catch {
      return null
    }
  }

  async confirmShellForeground(id: string): Promise<boolean> {
    try {
      const result = await this.client.request<{ confirmed: boolean }>('confirmShellForeground', {
        sessionId: id
      })
      return result.confirmed === true
    } catch {
      return false
    }
  }

  async serialize(ids: string[]): Promise<string> {
    const sessions: Record<string, { initialCwd?: string }> = {}
    for (const id of ids) {
      sessions[id] = { initialCwd: this.initialCwds.get(id) }
    }
    return JSON.stringify(sessions)
  }

  async revive(_state: string): Promise<void> {
    // Sessions already live in the daemon — no revival needed
  }
}
