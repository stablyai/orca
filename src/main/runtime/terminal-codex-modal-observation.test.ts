import { describe, expect, it } from 'vitest'
import {
  TerminalCodexModalObservation,
  type TerminalModalFence
} from './terminal-codex-modal-observation'
import type { RuntimeVisibleTerminalState } from './runtime-terminal-state-records'

const text =
  'Select model for Codex\nPress enter to confirm or esc to go back\nModel changed to gpt-6-astra medium'
const fence: TerminalModalFence = { generation: 1, outputSequence: 20, permissionSequence: 4 }
const screen: RuntimeVisibleTerminalState = {
  lines: ['› Ask Codex to do anything', 'gpt-6-astra · medium'],
  codexComposer: true,
  generation: 1,
  sequence: 20,
  isAlternateScreen: false
}

describe('model modal evidence fences', () => {
  it.each([
    ['unavailable screen', null, fence],
    ['unreadable composer', { ...screen, codexComposer: undefined }, fence],
    ['stale output', { ...screen, sequence: 19 }, fence],
    ['future output', { ...screen, sequence: 21 }, fence],
    ['stale incarnation', { ...screen, generation: 0 }, fence],
    ['generation changes during read', screen, { ...fence, generation: 2 }],
    ['output changes during read', screen, { ...fence, outputSequence: 21 }],
    ['permission arrives during read', screen, { ...fence, permissionSequence: 5 }],
    [
      'approval above the composer',
      { ...screen, lines: ['Codex permission required', 'Allow once', 'Reject', ...screen.lines] },
      fence
    ]
  ])('keeps %s fail closed', (_name, visible, after) => {
    const observation = new TerminalCodexModalObservation()
    const record = {}
    observation.reconcile(record, text, fence, after, visible)
    expect(observation.read(record, text, after)).toBe(text)
  })

  it('does not retire a real approval even when it has disappeared', () => {
    const observation = new TerminalCodexModalObservation()
    const record = {}
    const approval = 'Codex permission required\nAllow once\nReject'
    observation.reconcile(record, approval, fence, fence, screen)
    expect(observation.read(record, approval, fence)).toBe(approval)
    const newerApproval = `${text}\n${approval}`
    observation.reconcile(record, newerApproval, fence, fence, screen)
    expect(observation.read(record, newerApproval, fence)).toBe(newerApproval)
  })

  it('fences a retirement by pane, generation, permission sequence and the exact retained prefix', () => {
    const observation = new TerminalCodexModalObservation()
    const record = {}
    observation.reconcile(record, text, fence, fence, screen)
    expect(observation.read(record, text, fence)).toBe('Model changed to gpt-6-astra medium')
    expect(observation.read({}, text, fence)).toBe(text)
    expect(observation.read(record, text, { ...fence, generation: 2 })).toBe(text)
    expect(observation.read(record, text, { ...fence, permissionSequence: 5 })).toBe(text)
    expect(observation.read(record, `different history\n${text}`, fence)).toContain('Press enter')
    const next = `${text}\nCodex permission required\nAllow once\nReject`
    expect(observation.read(record, next, fence)).toContain('Codex permission required')
    expect(observation.isReady(record, text, { ...fence, outputSequence: 21 })).toBe(false)
  })
})
