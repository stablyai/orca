import { createInterface } from 'node:readline'

const threadId = 'thread-trae-contract'
let turnId
let serial = 0
let backgroundCommand = false
let delayedStartReply = null
let modelBackendVariant = 'max'
const models = [
  {
    id: 'contract-id',
    model: 'contract-model',
    displayName: 'Contract model',
    isDefault: true,
    hidden: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium', description: 'Medium' },
      { reasoningEffort: 'high', description: 'High' }
    ],
    businessMetadata: { variants: { max_key: 'contract-large' } }
  },
  {
    id: 'small-id',
    model: 'small-model',
    displayName: 'Standard-only model',
    isDefault: false,
    hidden: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [],
    businessMetadata: { variants: { max_key: null } }
  },
  {
    id: 'custom-id',
    model: 'custom-model',
    displayName: 'Custom model',
    modelProviderId: 'custom-provider',
    isDefault: false,
    hidden: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [],
    businessMetadata: { variants: { max_key: null } }
  }
]
const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`)
const reply = (id, result) => send({ id, result })
const notify = (method, params) => send({ method, params: { threadId, ...params } })
const complete = (text, status = 'completed') => {
  notify('item/agentMessage/delta', { turnId, itemId: `answer-${turnId}`, delta: text })
  notify('item/completed', {
    turnId,
    item: { id: `answer-${turnId}`, type: 'agentMessage', text }
  })
  notify('turn/completed', { turn: { id: turnId, status, items: [] } })
}

createInterface({ input: process.stdin })
  .on('line', (line) => {
    const request = JSON.parse(line)
    const { id, method, params } = request
    if (method === 'initialize') {
      reply(id, { userAgent: 'trae-contract' })
    } else if (method === 'thread/start' || method === 'thread/resume') {
      const startupVariant =
        params.config && Object.hasOwn(params.config, 'model_backend_variant')
          ? params.config.model_backend_variant || null
          : modelBackendVariant
      const selected = models.find(
        (model) => model.id === params.model || model.model === params.model
      )
      if (selected && !selected.businessMetadata.variants.max_key && startupVariant !== null) {
        send({ id, error: { code: -32602, message: 'Selected model does not provide Max mode' } })
        return
      }
      modelBackendVariant = startupVariant
      reply(id, {
        thread: { id: threadId, turns: [] },
        model: selected?.model ?? 'contract-model',
        ...(modelBackendVariant ? { modelBackendVariant } : {}),
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: { type: 'readOnly' }
      })
    } else if (method === 'model/list') {
      reply(id, {
        data: models,
        nextCursor: null
      })
    } else if (method === 'thread/settings/update') {
      if (Object.hasOwn(params, 'modelBackendVariant')) {
        modelBackendVariant = params.modelBackendVariant
      }
      const threadSettings = { ...params, modelBackendVariant }
      reply(id, { threadSettings })
      notify('thread/settings/updated', { threadSettings })
    } else if (method === 'model/internalUsage/read') {
      reply(id, { usage: null, dailyUsage: null })
    } else if (method === 'account/rateLimits/read') {
      reply(id, { rateLimits: { primary: null, secondary: null }, rateLimitsByLimitId: null })
    } else if (method === 'collaborationMode/list') {
      reply(id, {
        data: [
          { mode: 'default', name: 'Default' },
          { mode: 'plan', name: 'Plan' }
        ]
      })
    } else if (method === 'skills/list') {
      reply(id, { data: [{ cwd: params.cwds[0], skills: [] }] })
    } else if (method === 'thread/goal/get') {
      reply(id, { goal: null })
    } else if (method === 'thread/contextUsage') {
      reply(id, { snapshot: null, contextWindowUsage: null })
    } else if (method === 'thread/backgroundTerminals/list') {
      reply(id, {
        processIds: backgroundCommand && params.threadId === threadId ? ['pty-contract'] : []
      })
    } else if (method === 'thread/backgroundTerminals/stop') {
      backgroundCommand = false
      reply(id, { outcome: 'terminationRequested' })
    } else if (method === 'turn/start') {
      const selected = models.find((model) => model.model === params.model)
      if (!selected) {
        send({ id, error: { code: -32602, message: 'Expected the sampling model name' } })
        return
      }
      if (!selected.businessMetadata.variants.max_key && params.modelBackendVariant !== null) {
        send({ id, error: { code: -32602, message: 'Selected model does not provide Max mode' } })
        return
      }
      if (selected.modelProviderId && params.modelProvider !== selected.modelProviderId) {
        send({ id, error: { code: -32602, message: 'Selected model provider was not supplied' } })
        return
      }
      if (params.input[0].text === 'model-rejected') {
        send({ id, error: { code: -32602, message: 'Selected model is unavailable' } })
        return
      }
      if (Object.hasOwn(params, 'modelBackendVariant')) {
        modelBackendVariant = params.modelBackendVariant
      }
      turnId = `turn-${++serial}`
      const text = params.input[0].text
      if (text === 'model-queue-history') {
        notify('queue/status', {
          turnId: 'past-turn',
          state: 'queued',
          position: 99,
          operation: null,
          modelQuotaLowPriority: false,
          message: null
        })
      }
      if (text.startsWith('model-queue')) {
        notify('queue/status', {
          turnId,
          state: 'queued',
          operation: null,
          modelQuotaLowPriority: false,
          position: text === 'model-queue-unknown' ? null : text === 'model-queue-zero' ? 0 : 12,
          message: null
        })
      }
      if (text === 'model-queue-before-ack') {
        delayedStartReply = id
        return
      }
      reply(id, { turn: { id: turnId, status: 'inProgress', items: [] } })
      notify('turn/started', { turn: { id: turnId, status: 'inProgress', items: [] } })
      notify('item/completed', {
        turnId,
        item: { id: params.userMessageId, type: 'userMessage', content: params.input }
      })
      if (text.startsWith('model-queue')) {
        notify('queue/status', {
          turnId: 'other-turn',
          state: 'ready',
          position: null,
          operation: null,
          modelQuotaLowPriority: false,
          message: null
        })
        return
      }
      if (text === 'context-mode') {
        complete(JSON.stringify({ modelBackendVariant }))
      } else if (text === 'context-mode-wait') {
        notify('thread/settings/updated', { threadSettings: { modelBackendVariant } })
      } else if (text === 'model-switch') {
        complete('Model switch accepted')
      } else if (text === 'permissions') {
        send({
          id: 'permissions',
          method: 'item/permissions/requestApproval',
          params: {
            threadId,
            turnId,
            permissions: { network: { enabled: true }, fileSystem: { write: ['/workspace'] } }
          }
        })
      } else if (text === 'approval-and-question') {
        send({
          id: 'approval',
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId,
            turnId,
            itemId: 'command',
            command: 'echo safe',
            availableDecisions: ['accept', 'decline', 'cancel']
          }
        })
      } else if (text === 'file-approval') {
        notify('item/started', {
          turnId,
          item: { id: 'file-edit', type: 'fileChange', status: 'inProgress', changes: [] }
        })
        notify('item/fileChange/patchUpdated', {
          turnId,
          itemId: 'file-edit',
          changes: [
            { path: '/workspace/a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new' },
            { path: '/workspace/b.ts', kind: { type: 'add' }, diff: '@@ -0,0 +1 @@\n+second' }
          ]
        })
        send({
          id: 'file-approval',
          method: 'item/fileChange/requestApproval',
          params: {
            threadId,
            turnId,
            itemId: 'file-edit',
            grantRoot: '/workspace',
            reason: 'Write outside sandbox'
          }
        })
      } else if (text === 'after-option-change') {
        complete(`EFFORT:${params.effort}`)
      } else if (text === 'unknown-request') {
        send({ id: 'unknown', method: 'new/blocking/request', params: { threadId, turnId } })
      } else if (text === 'parity-audit') {
        notify('turn/plan/updated', {
          turnId,
          plan: [
            { step: 'Inspect', status: 'completed' },
            { step: 'Implement', status: 'inProgress' }
          ]
        })
        notify('item/started', { turnId, item: { type: 'plan', id: 'plan-audit', text: '' } })
        notify('item/plan/delta', { turnId, itemId: 'plan-audit', delta: 'Draft plan' })
        notify('item/completed', {
          turnId,
          item: { type: 'plan', id: 'plan-audit', text: 'Final plan' }
        })
        notify('thread/tokenUsage/updated', {
          turnId,
          tokenUsage: { last: { totalTokens: 100 }, modelContextWindow: 1000 },
          context: {
            contextUsage: {
              threadId,
              model: 'contract-model',
              activeContextTokens: 512,
              effectiveContextWindow: 1000,
              usedPercentage: 51,
              sampledAt: 100,
              categories: [
                { kind: 'systemPrompt', tokens: 300 },
                { kind: 'userMessages', tokens: 212 }
              ]
            }
          }
        })
        notify('item/completed', {
          turnId,
          item: { type: 'imageView', id: 'view-audit', path: '/tmp/view-audit.png' }
        })
        notify('item/completed', {
          turnId,
          item: {
            type: 'webSearch',
            id: 'search-audit',
            action: { type: 'openPage', url: 'https://example.com' },
            results: [{ title: 'Example', url: 'https://example.com' }]
          }
        })
        notify('item/agentMessage/delta', {
          turnId,
          itemId: 'async-message',
          delta: 'Choose a route'
        })
        notify('item/completed', {
          turnId,
          item: {
            type: 'agentMessage',
            id: 'async-message',
            text: 'Choose a route',
            delivery: 'async',
            questions: [{ title: 'Route?', options: ['A', 'B'] }]
          }
        })
        notify('guardianWarning', {
          message:
            'Automatic approval review approved (risk: low, authorization: high): inspect files.'
        })
        notify('model/rerouted', { turnId, fromModel: 'contract-model', toModel: 'fallback-model' })
        notify('mode/changeRequested', {
          turnId,
          requestId: 'mode-audit',
          targetMode: 'default',
          reason: 'Execute the plan',
          allowedPrompts: []
        })
      } else if (text === 'child-work') {
        notify('item/completed', {
          turnId,
          item: {
            type: 'collabAgentToolCall',
            id: 'spawn-child',
            tool: 'spawnAgent',
            status: 'completed',
            receiverThreadIds: ['child-contract'],
            agentNickname: 'Reviewer',
            agentsStates: {}
          }
        })
        notify('turn/started', {
          threadId: 'child-contract',
          turn: { id: 'child-turn', status: 'inProgress' }
        })
        notify('item/agentMessage/delta', {
          threadId: 'child-contract',
          turnId: 'child-turn',
          itemId: 'msg_0',
          delta: 'CHILD_CONTRACT_TEXT'
        })
        notify('item/completed', {
          threadId: 'child-contract',
          turnId: 'child-turn',
          item: { type: 'agentMessage', id: 'msg_0', text: 'CHILD_CONTRACT_TEXT' }
        })
        notify('thread/tokenUsage/updated', {
          threadId: 'child-contract',
          tokenUsage: { total: { totalTokens: 42 } }
        })
        notify('item/completed', {
          threadId: 'child-contract',
          turnId: 'child-turn',
          item: {
            type: 'collabAgentToolCall',
            id: 'spawn-grandchild',
            tool: 'spawnAgent',
            status: 'completed',
            receiverThreadIds: ['grandchild-contract'],
            agentNickname: 'Nested reviewer',
            agentsStates: {}
          }
        })
        notify('turn/started', {
          threadId: 'grandchild-contract',
          turn: { id: 'grandchild-turn', status: 'inProgress' }
        })
        notify('item/completed', {
          threadId: 'grandchild-contract',
          turnId: 'grandchild-turn',
          item: { type: 'agentMessage', id: 'msg_0', text: 'GRANDCHILD_CONTRACT_TEXT' }
        })
        notify('item/completed', {
          threadId: 'stray-thread',
          turnId: 'stray-turn',
          item: { type: 'agentMessage', id: 'msg_0', text: 'STRAY_TEXT' }
        })
        backgroundCommand = true
        notify('item/started', {
          turnId,
          item: {
            type: 'commandExecution',
            id: 'command-child-work',
            command: 'sleep 40',
            processId: 'pty-contract',
            status: 'inProgress'
          }
        })
        complete('ROOT_CONTRACT_DONE')
      }
    } else if (method === 'turn/steer') {
      reply(id, { turnId })
      notify('item/completed', {
        turnId,
        item: { id: params.userMessageId, type: 'userMessage', content: params.input }
      })
      notify('queue/status', {
        turnId,
        state: 'waiting',
        position: 3,
        operation: null,
        modelQuotaLowPriority: false,
        message: null
      })
      if (params.input[0].text === 'queue-update') {
        return
      }
      if (params.input[0].text === 'queue-stream') {
        notify('item/agentMessage/delta', { turnId, itemId: 'queue-stream', delta: 'STREAMING' })
        return
      }
      notify('queue/status', {
        turnId,
        state: 'ready',
        position: null,
        operation: null,
        modelQuotaLowPriority: false,
        message: null
      })
      complete('QUEUE_DONE')
      notify('queue/status', {
        turnId,
        state: 'queued',
        position: 99,
        operation: null,
        modelQuotaLowPriority: false,
        message: null
      })
    } else if (id === 'permissions') {
      complete(JSON.stringify(request.result))
    } else if (id === 'approval') {
      if (request.result.decision !== 'accept') {
        complete('denied')
        return
      }
      send({
        id: 'question',
        method: 'item/tool/requestUserInput',
        params: {
          threadId,
          turnId,
          itemId: 'ask',
          questions: [
            {
              id: 'color',
              question: 'Choose color',
              options: [{ label: 'Blue' }, { label: 'Red' }]
            },
            { id: 'name', question: 'Enter a name', options: [] }
          ]
        }
      })
    } else if (id === 'question') {
      complete(
        `${request.result.answers.color.answers[0]}:${request.result.answers.name.answers[0]}`
      )
    } else if (id === 'file-approval') {
      notify('item/completed', {
        turnId,
        item: { id: 'file-edit', type: 'fileChange', status: 'declined', changes: [] }
      })
      complete('file denied')
    } else if (id === 'unknown') {
      complete(request.error?.code === -32000 ? 'unrecognized request rejected' : 'unsafe reply')
    } else if (method === 'mode/change/respond') {
      reply(id, {})
      notify('mode/changeResolved', {
        turnId,
        requestId: params.requestId,
        targetMode: 'default',
        decision: params.decision
      })
      send({
        id: 'mcp-audit',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId,
          turnId,
          serverName: 'Audit MCP',
          mode: 'form',
          message: 'Approve the tool',
          requestedSchema: { type: 'object', properties: {} },
          _meta: {
            codex_approval_kind: 'mcp_tool_call',
            persist: ['session'],
            tool_params: { path: '/workspace/report.txt' }
          }
        }
      })
    } else if (id === 'mcp-audit') {
      if (request.result.action !== 'accept' || request.result._meta?.persist !== 'session') {
        throw new Error('Wrong MCP response')
      }
      send({
        id: 'nonblocking-audit',
        method: 'item/tool/requestUserInput',
        params: {
          threadId,
          turnId,
          itemId: 'nonblocking',
          isBlocking: false,
          questions: [
            {
              id: 'q-audit',
              question: 'Pick more than one',
              multiSelect: true,
              options: [{ label: 'A' }, { label: 'B' }]
            }
          ]
        }
      })
    } else if (id === 'nonblocking-audit') {
      notify('error', {
        turnId,
        willRetry: false,
        error: { message: 'Capacity unavailable', codexErrorInfo: 'serverOverloaded' }
      })
      notify('turn/completed', {
        turn: {
          id: turnId,
          status: 'failed',
          error: { message: 'Capacity unavailable', codexErrorInfo: 'serverOverloaded' }
        }
      })
    } else if (method === 'turn/interrupt') {
      if (delayedStartReply !== null) {
        reply(delayedStartReply, { turn: { id: turnId, status: 'interrupted', items: [] } })
        delayedStartReply = null
      }
      reply(id, {})
      notify('turn/completed', {
        threadId: params.threadId,
        turn: { id: params.turnId ?? turnId, status: 'interrupted', items: [] }
      })
    } else if (method === 'thread/recap') {
      const recapTurn = `recap-${++serial}`
      const outcome =
        serial === 1
          ? {
              method: 'recap/generated',
              params: { threadId, turnId: recapTurn, text: 'Saved recap' }
            }
          : {
              method: 'recap/failed',
              params: { threadId, turnId: recapTurn, reason: 'generationFailed' }
            }
      process.stdout.write(
        `${JSON.stringify({ id, result: { turnId: recapTurn } })}\n${JSON.stringify(outcome)}\n`
      )
    } else if (method === 'windowsSandbox/setupStart') {
      const success = params.cwd !== 'sandbox-failure'
      process.stdout.write(
        `${JSON.stringify({ id, result: { started: true } })}\n${JSON.stringify({
          method: 'windowsSandbox/setupCompleted',
          params: { requestId: id, success, error: success ? null : 'Setup refused' }
        })}\n`
      )
    } else if (method === 'thread/compact/start') {
      turnId = `compact-${++serial}`
      if (params.userGuidance === 'queue-compaction') {
        notify('queue/status', {
          turnId,
          state: 'queued',
          position: 12,
          operation: 'contextCompaction',
          modelQuotaLowPriority: false,
          message: null
        })
      }
      reply(id, {})
      notify('turn/started', { turn: { id: turnId, status: 'inProgress', items: [] } })
      if (params.userGuidance === 'queue-compaction') {
        return
      }
      if (params.userGuidance === 'fail-compaction') {
        notify('turn/completed', {
          turn: {
            id: turnId,
            status: 'failed',
            error: { message: 'Quota exceeded', codexErrorInfo: 'usageLimitExceeded' }
          }
        })
        return
      }
      notify('item/completed', { turnId, item: { type: 'contextCompaction', id: 'compaction' } })
      notify('thread/compacted', { turnId })
      notify('turn/completed', {
        turn: { id: turnId, status: 'completed', items: [], durationMs: 2500, completedAt: 103 }
      })
    } else if (method === 'thread/turns/list') {
      reply(id, { data: [], nextCursor: null })
    }
  })
  .on('close', () => process.exit(0))
