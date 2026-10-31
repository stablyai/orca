// A structured Claude chat on the desktop, read back with `agentSession.history` after its owner
// approved a Bash call and answered an AskUserQuestion (Claude Code 2.1.300, 2026-10-15).

import type { AgentJournalRenderItem } from '../../../../../src/shared/agent-session-journal-types'

export const ANSWERED_PROMPT_ITEMS: AgentJournalRenderItem[] = [
  {
    itemId: 'orca:1792024009236-87ed41e5430c47008ef7978ca5d60505',
    revision: 0,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [
        {
          type: 'text',
          text: 'Run the bash command: echo receipt-check > receipt.txt'
        }
      ]
    },
    sequence: 43,
    observedAt: 1792024010442,
    turnScope: {
      kind: 'thread'
    }
  },
  {
    itemId:
      'orca:claude-tool%3A2ee61cec-1207-4f44-a915-b6adbcbf169b%3Atoolu_01FhhC72BuRiD3d9hXkAsURD',
    revision: 2,
    body: {
      kind: 'tool-call',
      name: 'Bash',
      input: {
        command: 'echo receipt-check > receipt.txt',
        description: 'Write receipt-check to receipt.txt'
      },
      callId: 'toolu_01FhhC72BuRiD3d9hXkAsURD',
      state: 'completed',
      output: {
        head: '(Bash completed with no output)',
        byteLength: 31,
        digest: 'cac1685585590361647e7a27b58a25a590f335bfcd0ab70fcdc0424e40c20843',
        truncated: false
      }
    },
    sequence: 46,
    observedAt: 1792024014854,
    turnScope: {
      kind: 'turn',
      turnItemId:
        'legacy:claude:2ee61cec-1207-4f44-a915-b6adbcbf169b:turn-lifecycle%3A6a80bc01-4be4-466f-bd98-5cae8368ed1d'
    }
  },
  {
    itemId:
      'orca:claude-prompt%3Aclaude_c65b4304_2acf_4eec_a749_e06876328e0c%3A79c45210-730e-482c-82bd-db0708c992e5',
    revision: 2,
    body: {
      kind: 'approval',
      title: 'Allow Bash?',
      displayName: 'Bash',
      description: 'Write receipt-check to receipt.txt',
      blockedPath: '/private/tmp/mnw-scratch/receipt.txt',
      detail:
        '{\n  "command": "echo receipt-check > receipt.txt",\n  "description": "Write receipt-check to receipt.txt"\n}',
      options: [
        {
          id: 'allow',
          label: 'Allow'
        },
        {
          id: 'allowForSession',
          label: 'Allow for this session'
        },
        {
          id: 'deny',
          label: 'Deny'
        }
      ],
      resolution: {
        state: 'resolved',
        selectedOptionId: 'allow',
        resolvedBy: 'desktop-renderer',
        resolvedAt: 1792024037937
      }
    },
    sequence: 48,
    observedAt: 1792024014910,
    turnScope: {
      kind: 'turn',
      turnItemId:
        'legacy:claude:2ee61cec-1207-4f44-a915-b6adbcbf169b:turn-lifecycle%3A6a80bc01-4be4-466f-bd98-5cae8368ed1d'
    }
  },
  {
    itemId: 'claude:2ee61cec-1207-4f44-a915-b6adbcbf169b:4408cf7b-bbe2-4a5d-aa80-6471db6d9c18',
    revision: 2,
    body: {
      kind: 'message',
      role: 'assistant',
      blocks: [
        {
          type: 'text',
          text: 'I ran the command. `receipt.txt` in `/private/tmp/mnw-scratch` now holds the line `receipt-check`.'
        }
      ]
    },
    sequence: 51,
    observedAt: 1792024040901,
    turnScope: {
      kind: 'turn',
      turnItemId:
        'legacy:claude:2ee61cec-1207-4f44-a915-b6adbcbf169b:turn-lifecycle%3A6a80bc01-4be4-466f-bd98-5cae8368ed1d'
    }
  },
  {
    itemId: 'orca:1792024048049-e58989ce33eb411a970225d03d2e4a18',
    revision: 0,
    body: {
      kind: 'message',
      role: 'user',
      blocks: [
        {
          type: 'text',
          text: 'Use the AskUserQuestion tool to ask me whether I prefer tea or coffee, then reply with my answer in one short sentence.'
        }
      ]
    },
    sequence: 57,
    observedAt: 1792024048075,
    turnScope: {
      kind: 'thread'
    }
  },
  {
    itemId:
      'orca:claude-tool%3A2ee61cec-1207-4f44-a915-b6adbcbf169b%3Atoolu_01WByTgphD4HFByq9zPKXn2J',
    revision: 2,
    body: {
      kind: 'tool-call',
      name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Do you prefer tea or coffee?',
            header: 'Drink',
            multiSelect: false,
            options: [
              {
                label: 'Tea',
                description: 'You prefer tea.'
              },
              {
                label: 'Coffee',
                description: 'You prefer coffee.'
              }
            ]
          }
        ]
      },
      callId: 'toolu_01WByTgphD4HFByq9zPKXn2J',
      state: 'completed',
      output: {
        head: 'Your questions have been answered: "Do you prefer tea or coffee?"="Coffee". You can now continue with these answers in mind.',
        byteLength: 124,
        digest: '65dfb0af315c9ab1c70fc26c6c6bfb4ef0138216e35c89cf332927d10cbb629d',
        truncated: false
      }
    },
    sequence: 60,
    observedAt: 1792024052205,
    turnScope: {
      kind: 'turn',
      turnItemId:
        'legacy:claude:2ee61cec-1207-4f44-a915-b6adbcbf169b:turn-lifecycle%3A1ea7cf09-10c6-4635-93bb-8d4b16fb1c60'
    }
  },
  {
    itemId:
      'orca:claude-prompt%3Aclaude_c65b4304_2acf_4eec_a749_e06876328e0c%3A6fd8be6a-830f-44b4-a3ef-a7f044cd4a4f',
    revision: 2,
    body: {
      kind: 'question',
      question: 'Do you prefer tea or coffee?',
      options: [
        {
          id: 'q1:choice-1',
          label: 'Tea',
          description: 'You prefer tea.'
        },
        {
          id: 'q1:choice-2',
          label: 'Coffee',
          description: 'You prefer coffee.'
        }
      ],
      freeTextQuestionId: 'q1',
      questions: [
        {
          id: 'q1',
          question: 'Do you prefer tea or coffee?',
          header: 'Drink',
          multiSelect: false,
          options: [
            {
              id: 'q1:choice-1',
              label: 'Tea',
              description: 'You prefer tea.'
            },
            {
              id: 'q1:choice-2',
              label: 'Coffee',
              description: 'You prefer coffee.'
            }
          ],
          freeTextQuestionId: 'q1'
        }
      ],
      resolution: {
        state: 'resolved',
        selectedOptionId: 'question-group:[{"questionId":"q1","optionIds":["q1:choice-2"]}]',
        answers: [
          {
            questionId: 'q1',
            optionIds: ['q1:choice-2']
          }
        ],
        resolvedBy: 'desktop-renderer',
        resolvedAt: 1792024081980
      }
    },
    sequence: 62,
    observedAt: 1792024052228,
    turnScope: {
      kind: 'turn',
      turnItemId:
        'legacy:claude:2ee61cec-1207-4f44-a915-b6adbcbf169b:turn-lifecycle%3A1ea7cf09-10c6-4635-93bb-8d4b16fb1c60'
    }
  },
  {
    itemId: 'claude:2ee61cec-1207-4f44-a915-b6adbcbf169b:32c8a879-b68c-41ba-9a9e-4b844fa07890',
    revision: 2,
    body: {
      kind: 'message',
      role: 'assistant',
      blocks: [
        {
          type: 'text',
          text: 'You prefer coffee.'
        }
      ]
    },
    sequence: 65,
    observedAt: 1792024084176,
    turnScope: {
      kind: 'turn',
      turnItemId:
        'legacy:claude:2ee61cec-1207-4f44-a915-b6adbcbf169b:turn-lifecycle%3A1ea7cf09-10c6-4635-93bb-8d4b16fb1c60'
    }
  }
]
