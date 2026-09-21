import { vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { PtyProcessInfo } from '../providers/pty-process-info'

export const WORKTREE = 'repo::/tmp/inventory-admission'
export const PTY = `${WORKTREE}@@shell`
export const PREDECESSOR = '30000000-0000-4000-8000-000000000001'
export const SUCCESSOR = '30000000-0000-4000-8000-000000000002'
const TAB = '30000000-0000-4000-8000-000000000003'
const LEAF = '30000000-0000-4000-8000-000000000004'

export type InventoryListing = NonNullable<RuntimePtyController['listProcesses']>

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

export function processRow(id = PTY, incarnationId = PREDECESSOR): PtyProcessInfo {
  return {
    id,
    cwd: '',
    title: 'captured listing',
    worktreeId: WORKTREE,
    incarnationId,
    terminalHandle: `term_${incarnationId}`
  }
}

export class InventoryLifecycleRuntime extends OrcaRuntimeService {
  read(connectionId?: string | null, target: string | null = null, deadline?: number) {
    return this.refreshPtyWorktreeRecordsWithControllerInventory([], target, deadline, connectionId)
  }

  register(incarnationId = PREDECESSOR): void {
    this.registerPreAllocatedHandleForPty(PTY, `term_${incarnationId}`)
    this.registerPty(PTY, WORKTREE, null, {
      tabId: TAB,
      leafId: LEAF,
      incarnationId,
      terminalHandle: `term_${incarnationId}`
    })
  }

  capture(id = PTY) {
    const pty = this.ptysById.get(id)
    return {
      connected: pty?.connected,
      incarnationId: pty?.incarnationId,
      controllerTitle: pty?.controllerTitle,
      tabId: pty?.tabId,
      paneKey: pty?.paneKey,
      handle: this.handleByPtyId.get(id) ?? null,
      verdict: this.getPtyLivenessVerdict(id),
      headless: this.headlessTerminals.has(id)
    }
  }
}

export function createInventoryRuntime(listProcesses: InventoryListing) {
  const runtime = new InventoryLifecycleRuntime()
  const hasPty = vi.fn(() => false)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses,
    hasPty
  })
  return { runtime, hasPty }
}
