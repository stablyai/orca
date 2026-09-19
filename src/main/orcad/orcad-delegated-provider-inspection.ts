import type { OrcadDelegatedProviderInput } from './orcad-delegated-provider-input'
import type { createOrcadDelegatedPtyOperations } from './orcad-delegated-pty-operations'
import type { IPtyProvider, PtyProcessInfo } from '../providers/pty-provider-contract'
import type { PtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import { getActiveSidebarWorkspaceId } from '../../shared/workspace-scope'

export class OrcadDelegatedProviderInspection {
  constructor(
    private readonly options: {
      identity: PtyOwnershipTransferWireIdentity
      workspaceKey: string
      input: Pick<OrcadDelegatedProviderInput, 'runControl'>
      operations: Pick<
        ReturnType<typeof createOrcadDelegatedPtyOperations>,
        'inspectCwd' | 'inspectTerminalInfo' | 'inspectProcess'
      >
    }
  ) {}

  inspectProcess = (id: string) =>
    this.options.input.runControl(id, async () => this.options.operations.inspectProcess(id))

  hasChildProcesses = async (id: string): Promise<boolean> => {
    const result = await this.inspectProcess(id)
    if (
      result.childProcessEvidence !== 'children' &&
      result.childProcessEvidence !== 'no-children'
    ) {
      throw new Error('orcad_delegated_children_unverifiable')
    }
    return result.childProcessEvidence === 'children'
  }

  listProcesses: IPtyProvider['listProcesses'] = (value = {}) => {
    const options = { ...value }
    const remaining = () => {
      if (options.deadlineMs === undefined) {
        return undefined
      }
      const timeoutMs = options.deadlineMs - Date.now()
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error('orcad_delegated_inventory_deadline_expired')
      }
      return timeoutMs
    }
    return this.options.input.runControl(this.options.identity.terminalId, async () => {
      const id = this.options.identity.terminalId
      const cwd = await this.options.operations.inspectCwd(id, remaining())
      if (cwd === null) {
        throw new Error('orcad_delegated_inventory_unverifiable')
      }
      const process = options.includeForegroundProcessEvidence
        ? await this.options.operations.inspectProcess(id, remaining())
        : undefined
      const info = await this.options.operations.inspectTerminalInfo(id, remaining())
      remaining()
      if (!info) {
        throw new Error('orcad_delegated_inventory_unverifiable')
      }
      const worktreeId = getActiveSidebarWorkspaceId(this.options.workspaceKey, null)
      const result: PtyProcessInfo = {
        id,
        incarnationId: this.options.identity.incarnationId,
        rootProcessId: info.pid,
        ...(info.terminalHandle ? { terminalHandle: info.terminalHandle } : {}),
        cwd,
        title: '',
        ...(worktreeId ? { worktreeId } : {}),
        ...(process ? { foregroundProcessEvidence: process.foregroundProcessEvidence } : {})
      }
      return [result]
    })
  }

  getForegroundProcess = async (id: string): Promise<string | null> => {
    const result = await this.inspectProcess(id)
    if (result.foregroundProcessEvidence.verdict !== 'live') {
      throw new Error('orcad_delegated_foreground_unverifiable')
    }
    return result.foregroundProcessEvidence.processName
  }

  getCwd = (id: string): Promise<string> =>
    this.options.input.runControl(id, async () => {
      const cwd = await this.options.operations.inspectCwd(id)
      if (cwd === null) {
        throw new Error('orcad_delegated_cwd_unverifiable')
      }
      return cwd
    })

  getInitialCwd = (id: string): Promise<string> =>
    this.options.input.runControl(id, async () => {
      const info = await this.options.operations.inspectTerminalInfo(id)
      if (!info) {
        throw new Error('orcad_delegated_initial_cwd_unverifiable')
      }
      return info.initialCwd
    })

  getAppliedSize = (id: string): Promise<{ cols: number; rows: number } | null> =>
    this.options.input.runControl(id, async () => {
      const info = await this.options.operations.inspectTerminalInfo(id)
      return info ? { cols: info.cols, rows: info.rows } : null
    })
}
