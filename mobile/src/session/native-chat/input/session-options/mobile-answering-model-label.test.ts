import { describe, expect, it } from 'vitest'
import type { SessionOptionDescriptor } from '../../../../../../src/shared/native-chat/input/native-chat-session-options'
import { withAnsweringModelLabel } from './mobile-answering-model-label'

function model(
  currentValue: string,
  valueSource: SessionOptionDescriptor['valueSource'] = 'reported'
): SessionOptionDescriptor {
  return {
    id: 'model',
    category: 'model',
    label: 'Model',
    kind: {
      type: 'select',
      currentValue,
      choices: [
        { value: 'opus', label: 'Opus' },
        { value: 'sonnet', label: 'Sonnet' }
      ]
    },
    valueSource
  } as SessionOptionDescriptor
}

function labels(descriptor: SessionOptionDescriptor): string[] {
  return descriptor.kind.type === 'select' ? descriptor.kind.choices.map((c) => c.label) : []
}

describe('withAnsweringModelLabel', () => {
  it('names the answering version on the reported choice and keeps its value', () => {
    const next = withAnsweringModelLabel(model('opus'), 'claude-opus-5-5')
    expect(labels(next)).toEqual(['Opus 5.5', 'Sonnet'])
    expect(next.kind).toMatchObject({ currentValue: 'opus' })
  })

  it('leaves a model picked on the phone alone', () => {
    const picked = model('sonnet', 'dispatched')
    expect(withAnsweringModelLabel(picked, 'claude-opus-5-5')).toBe(picked)
  })

  it('adds a labelled choice when the catalog does not list the reported value', () => {
    const next = withAnsweringModelLabel(model('claude-opus-5-5[1m]'), 'claude-opus-5-5')
    expect(next).toEqual(model('claude-opus-5-5[1m]'))
    const unlisted = withAnsweringModelLabel(model('opus-next'), 'claude-opus-5-5')
    expect(labels(unlisted)).toEqual(['Opus', 'Sonnet', 'Opus 5.5'])
  })
})
