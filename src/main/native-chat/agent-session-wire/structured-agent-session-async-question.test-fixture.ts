import { codexItemBody } from '../../codex/codex-structured-item-translation'

export function asyncQuestionBody(id = 'provider-call') {
  const body = codexItemBody({
    type: 'agentMessage',
    id,
    text: 'Which color?',
    delivery: 'async',
    questions: [{ title: 'Which color?', options: ['Red', 'Blue'] }]
  })
  if (body?.kind !== 'message') {
    throw new Error('expected recorded async question')
  }
  return body
}
