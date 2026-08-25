import { describe, expect, it } from 'vitest'
import {
  ASK_UI_TITLE,
  HANDSHAKE_STATUS_KEY,
  PI_RPC_WORKER_ACTIVE_TOOL_NAMES,
  type WorkspaceRuntimeDescriptor
} from './extension-source'
import { PiWorkerLifecycle } from './lifecycle'

const workspaceRuntime: WorkspaceRuntimeDescriptor = {
  sourceHash: 'a'.repeat(64),
  securitySource: 'file:///runtime/workspace-security.ts',
  mutationSource: 'file:///runtime/workspace-mutation.ts'
}

function handshakeStatus(source = 'pi'): string {
  return JSON.stringify({
    protocol: 'orca.pi.rpc-worker.handshake',
    version: 1,
    nonce: 'nonce',
    source,
    workspaceRuntime: {
      sha256: workspaceRuntime.sourceHash,
      sources: [workspaceRuntime.securitySource, workspaceRuntime.mutationSource]
    },
    tools: PI_RPC_WORKER_ACTIVE_TOOL_NAMES.map((name) => ({ name, source }))
  })
}

function startedLifecycle(): PiWorkerLifecycle {
  const lifecycle = new PiWorkerLifecycle('nonce', 'pi', workspaceRuntime)
  expect(
    lifecycle.handle({
      type: 'extension_ui_request',
      id: 'ui-handshake',
      method: 'setStatus',
      statusKey: HANDSHAKE_STATUS_KEY,
      statusText: handshakeStatus()
    })
  ).toEqual([{ type: 'handshake' }])
  lifecycle.markPromptSent('prompt-1')
  lifecycle.handle({
    type: 'response',
    id: 'prompt-1',
    command: 'prompt',
    success: true
  })
  expect(lifecycle.handle({ type: 'agent_start' })).toEqual([{ type: 'working' }])
  return lifecycle
}

const doneArgs = {
  outcome: 'succeeded',
  subject: 'Implemented lifecycle',
  body: 'Implemented the worker. Tests pass. Nothing remains.',
  filesModified: ['src/a.ts']
}

function lifecycleResult(kind: string, payload: unknown) {
  return {
    details: { protocol: 'orca.pi.lifecycle', version: 1, kind, payload }
  }
}

describe('Pi worker lifecycle state machine', () => {
  it('settles only after a valid done tool end and clean Pi shutdown', () => {
    const lifecycle = startedLifecycle()
    lifecycle.handle({
      type: 'tool_execution_start',
      toolCallId: 'done-1',
      toolName: 'orca_worker_done',
      args: doneArgs
    })
    expect(
      lifecycle.handle({
        type: 'tool_execution_end',
        toolCallId: 'done-1',
        toolName: 'orca_worker_done',
        isError: false,
        result: lifecycleResult('worker_done', {
          body: doneArgs.body,
          filesModified: doneArgs.filesModified,
          subject: doneArgs.subject,
          outcome: doneArgs.outcome
        })
      })
    ).toEqual([{ type: 'done', input: doneArgs }])
    expect(lifecycle.handle({ type: 'agent_settled' })).toEqual([{ type: 'idle' }])
    expect(lifecycle.assertCleanExit(0, null)).toEqual(doneArgs)
  })

  it('rejects missing, duplicate, error, and late completion', () => {
    const missing = startedLifecycle()
    expect(() => missing.handle({ type: 'agent_settled' })).toThrow('without a valid')

    const duplicate = startedLifecycle()
    duplicate.handle({
      type: 'tool_execution_start',
      toolCallId: 'done-1',
      toolName: 'orca_worker_done',
      args: doneArgs
    })
    expect(() =>
      duplicate.handle({
        type: 'tool_execution_start',
        toolCallId: 'done-2',
        toolName: 'orca_worker_done',
        args: doneArgs
      })
    ).toThrow('Duplicate Orca worker completion')

    const errored = startedLifecycle()
    errored.handle({
      type: 'tool_execution_start',
      toolCallId: 'done-1',
      toolName: 'orca_worker_done',
      args: doneArgs
    })
    expect(() =>
      errored.handle({
        type: 'tool_execution_end',
        toolCallId: 'done-1',
        toolName: 'orca_worker_done',
        isError: true
      })
    ).toThrow('completion tool failed')
  })

  it('correlates tool starts and ends by toolCallId and name', () => {
    const lifecycle = startedLifecycle()
    lifecycle.handle({
      type: 'tool_execution_start',
      toolCallId: 'read-1',
      toolName: 'read',
      args: { path: 'README.md' }
    })
    expect(() =>
      lifecycle.handle({
        type: 'tool_execution_end',
        toolCallId: 'read-1',
        toolName: 'write',
        isError: false
      })
    ).toThrow('did not match')
  })

  it('permits only one correlated coordinator prompt at a time', () => {
    const lifecycle = startedLifecycle()
    lifecycle.handle({
      type: 'tool_execution_start',
      toolCallId: 'ask-1',
      toolName: 'orca_ask_coordinator',
      args: { question: 'Choose?', options: ['A', 'B'] }
    })
    expect(
      lifecycle.handle({
        type: 'extension_ui_request',
        id: 'ui-ask-1',
        method: 'select',
        title: ASK_UI_TITLE,
        options: ['A', 'B']
      })
    ).toEqual([
      {
        type: 'ask',
        requestId: 'ui-ask-1',
        input: { question: 'Choose?', options: ['A', 'B'] }
      }
    ])
    expect(() =>
      lifecycle.handle({
        type: 'extension_ui_request',
        id: 'ui-ask-2',
        method: 'select',
        title: ASK_UI_TITLE,
        options: ['A', 'B']
      })
    ).toThrow('concurrent')
    lifecycle.markUiResponseSent('ui-ask-1')
    lifecycle.handle({
      type: 'tool_execution_end',
      toolCallId: 'ask-1',
      toolName: 'orca_ask_coordinator',
      isError: false,
      result: lifecycleResult('ask', { question: 'Choose?', options: ['A', 'B'] })
    })
  })

  it('rejects substituted runtime and active-tool handshake attestations', () => {
    const wrongRuntime = JSON.parse(handshakeStatus()) as Record<string, unknown>
    wrongRuntime.workspaceRuntime = { sha256: '0'.repeat(64), sources: [] }
    const runtimeLifecycle = new PiWorkerLifecycle('nonce', 'pi', workspaceRuntime)
    expect(() =>
      runtimeLifecycle.handle({
        type: 'extension_ui_request',
        method: 'setStatus',
        statusKey: HANDSHAKE_STATUS_KEY,
        statusText: JSON.stringify(wrongRuntime)
      })
    ).toThrow('did not bind')

    const wrongTools = JSON.parse(handshakeStatus()) as { tools: unknown[] }
    wrongTools.tools = wrongTools.tools.slice(1)
    const toolLifecycle = new PiWorkerLifecycle('nonce', 'pi', workspaceRuntime)
    expect(() =>
      toolLifecycle.handle({
        type: 'extension_ui_request',
        method: 'setStatus',
        statusKey: HANDSHAKE_STATUS_KEY,
        statusText: JSON.stringify(wrongTools)
      })
    ).toThrow('did not bind')
  })

  it('rejects UI traffic from any unselected extension', () => {
    const lifecycle = new PiWorkerLifecycle('nonce', 'pi', workspaceRuntime)
    expect(() =>
      lifecycle.handle({
        type: 'extension_ui_request',
        id: 'status-1',
        method: 'setStatus',
        statusKey: 'unselected-extension',
        statusText: 'unexpected'
      })
    ).toThrow('Unsupported')
  })

  it('rejects tool execution outside the exact attested surface', () => {
    const lifecycle = startedLifecycle()
    expect(() =>
      lifecycle.handle({
        type: 'tool_execution_start',
        toolCallId: 'bash-1',
        toolName: 'bash',
        args: { command: 'pwd' }
      })
    ).toThrow('outside the attested')
  })

  it('rejects lifecycle results that do not bind the selected call input', () => {
    const lifecycle = startedLifecycle()
    lifecycle.handle({
      type: 'tool_execution_start',
      toolCallId: 'done-1',
      toolName: 'orca_worker_done',
      args: doneArgs
    })
    expect(() =>
      lifecycle.handle({
        type: 'tool_execution_end',
        toolCallId: 'done-1',
        toolName: 'orca_worker_done',
        isError: false,
        result: lifecycleResult('worker_done', { ...doneArgs, subject: 'substituted' })
      })
    ).toThrow('did not match')
  })

  it('requires exact prompt response correlation', () => {
    const lifecycle = new PiWorkerLifecycle('nonce', 'pi', workspaceRuntime)
    lifecycle.handle({
      type: 'extension_ui_request',
      method: 'setStatus',
      statusKey: HANDSHAKE_STATUS_KEY,
      statusText: handshakeStatus()
    })
    lifecycle.markPromptSent('prompt-1')
    expect(() =>
      lifecycle.handle({ type: 'response', id: 'prompt-2', command: 'prompt', success: true })
    ).toThrow('did not match')
  })
})
