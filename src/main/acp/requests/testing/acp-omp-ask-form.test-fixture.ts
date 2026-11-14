// Verbatim `elicitation/create` from OMP 18.16.0's `ask` with three questions.
export const recordedOmpAskForm = {
  mode: 'form',
  sessionId: 'session-1',
  message: 'Answer 3 questions',
  requestedSchema: {
    type: 'object',
    properties: {
      q0: {
        type: 'string',
        title: 'Which database?',
        description: 'DB',
        oneOf: [
          { const: 'Postgres', title: 'Postgres', description: 'relational' },
          { const: 'SQLite', title: 'SQLite' },
          { const: 'Mongo', title: 'Mongo' }
        ],
        default: 'SQLite'
      },
      q0__other: { type: 'string', title: 'Other (type your own)' },
      q1: {
        type: 'array',
        title: 'Which features?',
        items: {
          anyOf: [
            { const: 'Auth', title: 'Auth' },
            { const: 'Billing', title: 'Billing' },
            { const: 'Search', title: 'Search' }
          ]
        }
      },
      q1__other: { type: 'string', title: 'Other (type your own)' },
      q2__other: { type: 'string', title: 'Other (type your own)' }
    }
  }
}
