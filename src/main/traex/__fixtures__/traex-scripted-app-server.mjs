import { createInterface } from 'node:readline'

const threadId = 'thread-trae-contract'
let turnId
let serial = 0
let backgroundCommand = false
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
      reply(id, {
        thread: { id: threadId, turns: [] },
        model: 'contract-model',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: { type: 'readOnly' }
      })
    } else if (method === 'model/list') {
      reply(id, {
        data: [
          {
            id: 'contract-id',
            model: 'contract-model',
            displayName: 'Contract model',
            isDefault: true,
            hidden: false,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }]
          }
        ],
        nextCursor: null
      })
    } else if (method === 'model/internalUsage/read') {
      reply(id, { usage: null, dailyUsage: null })
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
      if (params.model !== 'contract-model') {
        send({ id, error: { code: -32602, message: 'Expected the sampling model name' } })
        return
      }
      turnId = `turn-${++serial}`
      reply(id, { turn: { id: turnId, status: 'inProgress', items: [] } })
      notify('turn/started', { turn: { id: turnId, status: 'inProgress', items: [] } })
      notify('item/completed', {
        turnId,
        item: { id: params.userMessageId, type: 'userMessage', content: params.input }
      })
      const text = params.input[0].text
      if (text === 'approval-and-question') {
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
          _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session'] }
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
      reply(id, {})
      notify('turn/completed', {
        threadId: params.threadId,
        turn: { id: params.turnId ?? turnId, status: 'interrupted', items: [] }
      })
    } else if (method === 'thread/compact/start') {
      reply(id, {})
      turnId = `compact-${++serial}`
      notify('turn/started', { turn: { id: turnId, status: 'inProgress', items: [] } })
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
      notify('turn/completed', { turn: { id: turnId, status: 'completed', items: [] } })
    } else if (method === 'thread/turns/list') {
      reply(id, { data: [], nextCursor: null })
    }
  })
  .on('close', () => process.exit(0))
