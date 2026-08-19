import {
  ASK_UI_TITLE,
  HANDSHAKE_STATUS_KEY,
  PI_RPC_WORKER_ACTIVE_TOOL_NAMES,
  type WorkspaceRuntimeDescriptor
} from './extension-source'
import {
  assertLifecycleResult,
  boundedLifecycleText as text,
  isLifecycleTool,
  parseLifecycleToolInput
} from './lifecycle-contract'
import type {
  LifecycleToolInput,
  RpcObject,
  WorkerAskInput,
  WorkerDoneInput,
  WorkerEscalationInput,
  WorkerProgressInput
} from './types'

export { parseLifecycleToolInput } from './lifecycle-contract'

export type LifecycleAction =
  | { type: 'handshake' }
  | { type: 'working' }
  | { type: 'idle' }
  | { type: 'ask'; requestId: string; input: WorkerAskInput }
  | { type: 'progress'; input: WorkerProgressInput }
  | { type: 'escalation'; input: WorkerEscalationInput }
  | { type: 'done'; input: WorkerDoneInput }

type StartedTool = { name: string; lifecycle?: LifecycleToolInput }

export class PiWorkerLifecycle {
  private handshakeSeen = false
  private promptId: string | undefined
  private promptAccepted = false
  private agentStarted = false
  private settled = false
  private doneStarted = false
  private done: WorkerDoneInput | undefined
  private pendingAskId: string | undefined
  private readonly tools = new Map<string, StartedTool>()
  private readonly endedToolIds = new Set<string>()

  constructor(
    private readonly nonce: string,
    private readonly selectedSource: string,
    private readonly workspaceRuntime: WorkspaceRuntimeDescriptor
  ) {}

  markPromptSent(id: string): void {
    if (!this.handshakeSeen || this.promptId !== undefined || this.settled) {
      throw new Error('Pi RPC prompt is not allowed in the current lifecycle state')
    }
    this.promptId = text(id, 'prompt id', 256)
  }

  markUiResponseSent(id: string): void {
    if (this.pendingAskId !== id) {
      throw new Error('Coordinator answer does not match the pending Pi UI request')
    }
    this.pendingAskId = undefined
  }

  handle(event: RpcObject): LifecycleAction[] {
    const type = event.type
    if (typeof type !== 'string') {
      throw new Error('Pi RPC event has no type')
    }
    if (type === 'response') {
      this.handleResponse(event)
      return []
    }
    if (type === 'extension_ui_request') {
      return this.handleUiRequest(event)
    }
    if (type === 'agent_start') {
      if (!this.promptAccepted || this.agentStarted || this.settled) {
        throw new Error('Unexpected Pi agent_start')
      }
      this.agentStarted = true
      return [{ type: 'working' }]
    }
    if (type === 'tool_execution_start') {
      this.handleToolStart(event)
      return []
    }
    if (type === 'tool_execution_end') {
      const action = this.handleToolEnd(event)
      return action ? [action] : []
    }
    if (type === 'agent_settled') {
      if (
        !this.agentStarted ||
        this.settled ||
        !this.done ||
        this.tools.size !== 0 ||
        this.pendingAskId
      ) {
        throw new Error('Pi agent settled without a valid final completion')
      }
      this.settled = true
      return [{ type: 'idle' }]
    }
    if (type === 'extension_error') {
      throw new Error('Orca lifecycle extension failed')
    }
    return []
  }

  assertCleanExit(code: number | null, signal: NodeJS.Signals | null): WorkerDoneInput {
    if (code !== 0 || signal !== null || !this.settled || !this.done || this.tools.size !== 0) {
      throw new Error('Pi exited before lifecycle settlement completed cleanly')
    }
    return this.done
  }

  private handleResponse(event: RpcObject): void {
    const id = event.id
    if (typeof id !== 'string') {
      throw new Error('Pi RPC response omitted its correlation id')
    }
    if (id === this.promptId) {
      if (this.promptAccepted || event.command !== 'prompt' || event.success !== true) {
        throw new Error('Pi RPC prompt response was invalid or duplicated')
      }
      this.promptAccepted = true
      return
    }
    throw new Error('Pi RPC response id did not match a supervisor request')
  }

  private handleUiRequest(event: RpcObject): LifecycleAction[] {
    const method = event.method
    if (method === 'setStatus' && event.statusKey === HANDSHAKE_STATUS_KEY) {
      if (this.handshakeSeen || this.promptId !== undefined) {
        throw new Error('Duplicate Pi lifecycle handshake')
      }
      const expected = JSON.stringify({
        protocol: 'orca.pi.rpc-worker.handshake',
        version: 1,
        nonce: this.nonce,
        source: this.selectedSource,
        workspaceRuntime: {
          sha256: this.workspaceRuntime.sourceHash,
          sources: [this.workspaceRuntime.securitySource, this.workspaceRuntime.mutationSource]
        },
        tools: PI_RPC_WORKER_ACTIVE_TOOL_NAMES.map((name) => ({
          name,
          source: this.selectedSource
        }))
      })
      if (event.statusText !== expected) {
        throw new Error('Pi lifecycle handshake did not bind the selected source')
      }
      this.handshakeSeen = true
      return [{ type: 'handshake' }]
    }
    if ((method === 'input' || method === 'select') && event.title === ASK_UI_TITLE) {
      const requestId = text(event.id, 'UI request id', 256)
      const asks = [...this.tools.values()].filter(
        (tool) => tool.lifecycle?.name === 'orca_ask_coordinator'
      )
      if (asks.length !== 1 || this.pendingAskId || this.settled) {
        throw new Error('Unexpected or concurrent coordinator question')
      }
      const input = asks[0].lifecycle!.input as WorkerAskInput
      if (method === 'select') {
        if (!input.options || JSON.stringify(event.options) !== JSON.stringify(input.options)) {
          throw new Error('Coordinator question options changed in Pi UI')
        }
      } else if (input.options) {
        throw new Error('Coordinator options require the Pi select UI method')
      }
      this.pendingAskId = requestId
      return [{ type: 'ask', requestId, input }]
    }
    throw new Error('Unsupported Pi extension UI request')
  }

  private handleToolStart(event: RpcObject): void {
    if (!this.agentStarted || this.settled) {
      throw new Error('Pi tool started outside an active agent epoch')
    }
    if (this.doneStarted) {
      if (event.toolName === 'orca_worker_done') {
        throw new Error('Duplicate Orca worker completion')
      }
      throw new Error('Pi tool started after Orca worker completion')
    }
    const id = text(event.toolCallId, 'toolCallId', 512)
    const name = text(event.toolName, 'toolName', 256)
    if (!PI_RPC_WORKER_ACTIVE_TOOL_NAMES.some((activeName) => activeName === name)) {
      throw new Error('Pi started a tool outside the attested worker surface')
    }
    if (this.tools.has(id) || this.endedToolIds.has(id)) {
      throw new Error('Duplicate Pi tool start')
    }
    const lifecycle = isLifecycleTool(name) ? parseLifecycleToolInput(name, event.args) : undefined
    if (lifecycle?.name === 'orca_worker_done') {
      if (this.doneStarted) {
        throw new Error('Duplicate Orca worker completion')
      }
      this.doneStarted = true
    }
    this.tools.set(id, { name, lifecycle })
  }

  private handleToolEnd(event: RpcObject): LifecycleAction | undefined {
    const id = text(event.toolCallId, 'toolCallId', 512)
    const started = this.tools.get(id)
    if (!started || event.toolName !== started.name || this.endedToolIds.has(id)) {
      throw new Error('Pi tool end did not match one tool start')
    }
    this.tools.delete(id)
    this.endedToolIds.add(id)
    if (!started.lifecycle) {
      return undefined
    }
    if (event.isError === true) {
      if (started.lifecycle.name === 'orca_worker_done') {
        throw new Error('Orca worker completion tool failed')
      }
      return undefined
    }
    assertLifecycleResult(event.result, started.lifecycle)
    if (started.lifecycle.name === 'orca_worker_done') {
      if (this.tools.size !== 0) {
        throw new Error('Orca worker completion was not the final active tool')
      }
      this.done = started.lifecycle.input
      return { type: 'done', input: this.done }
    }
    if (started.lifecycle.name === 'orca_report_progress') {
      return { type: 'progress', input: started.lifecycle.input }
    }
    if (started.lifecycle.name === 'orca_escalate') {
      return { type: 'escalation', input: started.lifecycle.input }
    }
    return undefined
  }
}
