import { describe, expect, it } from 'vitest'
import {
  CONVERSATION_KNOWLEDGE_CLAIM_EXTRACTION_INSTRUCTION,
  parseConversationKnowledgeOutput,
  redactConversationText,
  resolveConversationKnowledgeModel,
  selectConversationSummaryMessages
} from './session-enrichment'
import { retainSourceBackedHandoff } from './conversation-knowledge-handoff-output'

describe('parseConversationKnowledgeOutput', () => {
  it('requires verbatim user evidence for qualifying structured claims', () => {
    expect(CONVERSATION_KNOWLEDGE_CLAIM_EXTRACTION_INSTRUCTION).toContain(
      'Copy those subject and object strings verbatim'
    )
    expect(CONVERSATION_KNOWLEDGE_CLAIM_EXTRACTION_INSTRUCTION).toContain(
      'Do not omit a qualifying claim'
    )
    expect(CONVERSATION_KNOWLEDGE_CLAIM_EXTRACTION_INSTRUCTION).toContain(
      'Framework A defines the core agent'
    )
  })

  it('redacts common credentials before history is sent to a generator', () => {
    expect(redactConversationText('api_key=sk-test_1234567890abcdef Bearer abcdefghijklmnop')).toBe(
      'api_key: [REDACTED_SECRET] Bearer [REDACTED_TOKEN]'
    )
  })

  it('uses a ChatGPT-compatible Codex model when the CLI rejects gpt-5.4', () => {
    expect(resolveConversationKnowledgeModel('codex', 'gpt-5.4')).toBe('gpt-5.6-sol')
    expect(resolveConversationKnowledgeModel('codex', 'gpt-5.3-codex')).toBe('gpt-5.6-sol')
    expect(resolveConversationKnowledgeModel('codex', 'gpt-5.5')).toBe('gpt-5.5')
  })

  it('parses a structured knowledge response and trims duplicate labels', () => {
    expect(
      parseConversationKnowledgeOutput(`\`\`\`json
        {
          "summary": " The session established the SSH lifecycle contract. ",
          "topics": ["SSH", "SSH", "process lifecycle"],
          "conclusions": ["Loss of contact is unverifiable."],
          "entities": ["Orca"],
          "searchTerms": ["remote disconnect", "remote disconnect", "SSH recovery"]
        }
      \`\`\``)
    ).toEqual({
      summary: 'The session established the SSH lifecycle contract.',
      topics: ['SSH', 'process lifecycle'],
      conclusions: ['Loss of contact is unverifiable.'],
      entities: ['Orca'],
      searchTerms: ['remote disconnect', 'SSH recovery'],
      handoff: []
    })
  })

  it('accepts legacy structured responses without search aliases', () => {
    expect(
      parseConversationKnowledgeOutput(
        '{"summary":"Summary","topics":[],"conclusions":[],"entities":[]}'
      ).searchTerms
    ).toEqual([])
  })

  it('rejects prose so failed generation cannot become cached knowledge', () => {
    expect(() => parseConversationKnowledgeOutput('Here is the summary: ...')).toThrow(
      'structured knowledge JSON'
    )
  })

  it('retains a reusable knowledge classification with its applicability', () => {
    expect(
      parseConversationKnowledgeOutput(
        JSON.stringify({
          summary: 'Use source-backed evidence before promoting knowledge.',
          topics: ['Knowledge'],
          conclusions: [],
          entities: [],
          handoff: [
            {
              kind: 'constraint',
              text: 'Preserve source evidence before promoting a candidate.',
              reliability: 'user-confirmed',
              evidence: { kind: 'conversation', messageId: 'user-1' },
              knowledge: {
                kind: 'constraint',
                applicability: 'When converting conversation material into knowledge notes.',
                reusable: true
              }
            }
          ]
        })
      ).handoff[0]?.knowledge
    ).toEqual({
      kind: 'constraint',
      applicability: 'When converting conversation material into knowledge notes.',
      reusable: true
    })
  })

  it('retains explicit navigation concepts for a source-backed statement', () => {
    expect(
      parseConversationKnowledgeOutput(
        JSON.stringify({
          summary: 'Use source-backed evidence before promoting knowledge.',
          topics: ['Knowledge map'],
          conclusions: [],
          entities: ['Evidence'],
          handoff: [
            {
              kind: 'constraint',
              text: 'Attach evidence only to directly related concepts.',
              reliability: 'user-confirmed',
              evidence: { kind: 'conversation', messageId: 'user-1' },
              concepts: ['Knowledge map', 'Evidence']
            }
          ]
        })
      ).handoff[0]?.concepts
    ).toEqual(['Knowledge map', 'Evidence'])
  })

  it('retains verified tool-result evidence for reusable findings', () => {
    const entry = {
      kind: 'progress' as const,
      text: 'The targeted test passed.',
      reliability: 'verified' as const,
      evidence: { kind: 'tool-result' as const, messageId: 'tool-1' },
      knowledge: {
        kind: 'finding' as const,
        applicability: 'Before merging this change.',
        reusable: true as const
      }
    }
    expect(retainSourceBackedHandoff([entry], [{ id: 'tool-1', role: 'tool' }])).toEqual([entry])
  })

  it('rejects a user-confirmed handoff when its evidence is not a user message', () => {
    expect(
      retainSourceBackedHandoff(
        [
          {
            kind: 'decision',
            text: 'Use the existing service.',
            reliability: 'user-confirmed',
            evidence: { kind: 'conversation', messageId: 'assistant-1' }
          },
          {
            kind: 'constraint',
            text: 'Keep paths cross-platform.',
            reliability: 'user-confirmed',
            evidence: { kind: 'conversation', messageId: 'user-1' }
          }
        ],
        [
          { id: 'assistant-1', role: 'assistant' },
          { id: 'user-1', role: 'user' }
        ]
      )
    ).toEqual([
      {
        kind: 'constraint',
        text: 'Keep paths cross-platform.',
        reliability: 'user-confirmed',
        evidence: { kind: 'conversation', messageId: 'user-1' }
      }
    ])
  })

  it('drops a claim key when its subject or value is absent from the user evidence', () => {
    const entry = {
      kind: 'decision' as const,
      text: 'Use Codex for summaries.',
      reliability: 'user-confirmed' as const,
      evidence: { kind: 'conversation' as const, messageId: 'user-1' },
      claim: {
        subject: 'Orca',
        relation: 'summary-agent',
        object: 'Codex',
        cardinality: 'single' as const
      }
    }
    expect(
      retainSourceBackedHandoff(
        [entry],
        [{ id: 'user-1', role: 'user', text: 'Use Claude for summaries.' }]
      )[0]?.claim
    ).toBeUndefined()
    expect(
      retainSourceBackedHandoff(
        [entry],
        [{ id: 'user-1', role: 'user', text: 'Orca uses Codex for summaries.' }]
      )[0]?.claim
    ).toEqual(entry.claim)
  })

  it('keeps a claim when supplemental user evidence confirms its choice', () => {
    const entry = {
      kind: 'decision' as const,
      text: 'Use NOOA with LangGraph.',
      reliability: 'user-confirmed' as const,
      evidence: {
        kind: 'conversation' as const,
        messageId: 'user-choice',
        supportingMessageIds: ['user-confirmation']
      },
      claim: {
        subject: 'NOOA',
        relation: 'workflow-wrapper',
        object: 'LangGraph',
        cardinality: 'single' as const
      }
    }
    expect(
      retainSourceBackedHandoff(
        [entry],
        [
          {
            id: 'user-choice',
            role: 'user',
            text: 'NOOA 做核心 agent 定义 + LangGraph 包外层状态机。'
          },
          { id: 'user-confirmation', role: 'user', text: '好，使用方案 A 进行吧。' }
        ]
      )
    ).toEqual([entry])
  })

  it('drops a claim when any supplemental evidence is not a user message', () => {
    const entry = {
      kind: 'decision' as const,
      text: 'Use NOOA with LangGraph.',
      reliability: 'user-confirmed' as const,
      evidence: {
        kind: 'conversation' as const,
        messageId: 'user-choice',
        supportingMessageIds: ['assistant-confirmation']
      },
      claim: {
        subject: 'NOOA',
        relation: 'workflow-wrapper',
        object: 'LangGraph',
        cardinality: 'single' as const
      }
    }
    expect(
      retainSourceBackedHandoff(
        [entry],
        [
          { id: 'user-choice', role: 'user', text: 'NOOA uses LangGraph.' },
          { id: 'assistant-confirmation', role: 'assistant', text: 'Confirmed.' }
        ]
      )[0]?.claim
    ).toBeUndefined()
  })

  it('drops a deictic confirmation claim while retaining its handoff', () => {
    const entry = {
      kind: 'decision' as const,
      text: 'Use plan A.',
      reliability: 'user-confirmed' as const,
      evidence: { kind: 'conversation' as const, messageId: 'user-1' },
      claim: {
        subject: '方案A',
        relation: 'chosen-approach',
        object: '进行',
        cardinality: 'single' as const
      }
    }
    expect(
      retainSourceBackedHandoff(
        [entry],
        [{ id: 'user-1', role: 'user', text: '好，使用方案A进行吧' }]
      )
    ).toEqual([{ ...entry, claim: undefined }])
  })

  it('samples the beginning, dynamic middle, and ending of long sessions', () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: `message-${index}`
    }))
    const selected = selectConversationSummaryMessages(messages)
    expect(selected).toHaveLength(12)
    const selectedText = selected.map((message) => message.text)
    expect(selectedText.slice(0, 3)).toEqual(['message-0', 'message-1', 'message-2'])
    expect(selectedText.slice(-3)).toEqual(['message-27', 'message-28', 'message-29'])
    const middle = selectedText.slice(3, -3).map((text) => Number(text.slice(8)))
    expect(middle.length).toBe(6)
    expect(new Set(middle).size).toBe(6)
    expect(middle.some((index) => index > 10 && index < 20)).toBe(true)
  })
})
