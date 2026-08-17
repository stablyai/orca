import type { IncrementalAgentFixture } from './session-scanner-incremental-fixtures'

// Prime Agent is a Pi fork sharing the message-graph format and Pi's
// `modelId` key; its own fixture exercises the registry's 'prime-agent'
// branch with the v3 tree-session header its releases write.
export function primeAgentFixture(): IncrementalAgentFixture {
  return {
    agent: 'prime-agent',
    fileName: 'dddddddd-eeee-4fff-8aaa-111111111111.jsonl',
    seedLines: [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'dddddddd-eeee-4fff-8aaa-111111111111',
        cwd: '/repo/app',
        timestamp: '2026-05-01T10:00:00.000Z'
      }),
      JSON.stringify({
        type: 'model_change',
        provider: 'prime-intellect',
        modelId: 'inference/big-model',
        timestamp: '2026-05-01T10:00:01.000Z'
      }),
      JSON.stringify({
        type: 'message',
        message: { role: 'user', content: [{ type: 'text', text: 'prime-agent seed question' }] },
        timestamp: '2026-05-01T10:00:05.000Z'
      })
    ],
    appendLines: [
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'prime-agent incremental answer' }],
          model: 'inference/big-model',
          usage: { input: 30, output: 10, totalTokens: 40 }
        },
        timestamp: '2026-05-01T10:01:00.000Z'
      })
    ],
    truncatedLines: [
      JSON.stringify({
        type: 'session',
        id: 'dddddddd-eeee-4fff-8aaa-111111111111',
        timestamp: '2026-05-01T10:00:00.000Z'
      })
    ]
  }
}
