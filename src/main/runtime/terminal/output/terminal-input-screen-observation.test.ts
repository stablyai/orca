import { expect, it } from 'vitest'
import { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import { TerminalRunFactsRegister } from '../lifecycle/terminal-run-facts'
import { captureTerminalInputScreen } from './terminal-input-screen-observation'

const frame = (draft: string, history = '') =>
  `${'\x1b[2J\x1b[H'}${history}──────────\r\n❯ ${draft}\r\n──────────\x1b[${history ? history.split('\r\n').length + 1 : 2};${3 + draft.length}H`

it('keeps unpainted input pending through unrelated output and an old matching prompt', async () => {
  const emulator = new HeadlessEmulator({ cols: 80, rows: 16 })
  const state = { emulator, writeChain: Promise.resolve() }
  const facts = new TerminalRunFactsRegister()
  facts.setInputScreenReader(() => captureTerminalInputScreen(state))
  try {
    await emulator.write(frame('', '❯ mine\r\nold answer\r\n'))
    facts.recordInput('pty', 'driving', 'mine\r')
    state.writeChain = state.writeChain.then(() =>
      emulator.write('\x1b[2;1Hbackground status mine\x1b[4;3H')
    )
    await facts.observeInputScreen('pty', captureTerminalInputScreen(state))
    expect(facts.hasUnobservedInput('pty')).toBe(true)
    state.writeChain = emulator.write(frame('', '❯ mine\r\nold answer\r\n❯ mine\r\nnew answer\r\n'))
    await facts.observeInputScreen('pty', captureTerminalInputScreen(state))
    expect(facts.hasUnobservedInput('pty')).toBe(false)
  } finally {
    emulator.dispose()
  }
})

it('waits for old queued paints before capturing the input baseline', async () => {
  const emulator = new HeadlessEmulator({ cols: 80, rows: 16 })
  const state = { emulator, writeChain: Promise.resolve() }
  const facts = new TerminalRunFactsRegister()
  facts.setInputScreenReader(() => captureTerminalInputScreen(state))
  try {
    state.writeChain = emulator.write(frame('', '❯ mine\r\nold answer\r\n'))
    facts.recordInput('pty', 'driving', 'mine\r')
    state.writeChain = state.writeChain.then(() => emulator.write('\x1b[2;1Hstatus\x1b[4;3H'))
    await facts.observeInputScreen('pty', captureTerminalInputScreen(state))
    expect(facts.hasUnobservedInput('pty')).toBe(true)
  } finally {
    emulator.dispose()
  }
})

it('cannot acknowledge later typing using an earlier submitted prompt', async () => {
  const facts = new TerminalRunFactsRegister()
  facts.setInputScreenReader(async () => ({ draft: '', lines: [] }))
  facts.recordInput('pty', 'driving', 'first\r')
  const old = facts.observeInputScreen('pty', Promise.resolve({ draft: '', lines: ['› first'] }))
  facts.recordInput('pty', 'driving', 'later')
  await old
  expect(facts.hasUnobservedInput('pty')).toBe(true)
  await facts.observeInputScreen('pty', Promise.resolve({ draft: '', lines: ['› first'] }))
  expect(facts.hasUnobservedInput('pty')).toBe(true)
  await facts.observeInputScreen('pty', Promise.resolve({ draft: 'later', lines: ['› first'] }))
  expect(facts.hasUnobservedInput('pty')).toBe(false)
})

it('recognizes its submitted text when the terminal wraps through the middle of a word', async () => {
  const emulator = new HeadlessEmulator({ cols: 30, rows: 16 })
  const state = { emulator, writeChain: Promise.resolve() }
  const facts = new TerminalRunFactsRegister()
  facts.setInputScreenReader(() => captureTerminalInputScreen(state))
  try {
    await emulator.write(frame(''))
    const text = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
    facts.recordInput('pty', 'driving', `${text}\r`)
    state.writeChain = state.writeChain.then(() =>
      emulator.write(`\x1b[2J\x1b[H❯ ${text}\x1b[6;1H──────────\r\n❯ \r\n──────────\x1b[7;3H`)
    )
    await facts.observeInputScreen('pty', captureTerminalInputScreen(state))
    expect(facts.hasUnobservedInput('pty')).toBe(false)
  } finally {
    emulator.dispose()
  }
})

it('does not carry an input observation across a model replacement or unknown baseline', async () => {
  const facts = new TerminalRunFactsRegister()
  const model = {}
  facts.setInputScreenReader(async () => ({ draft: '', model, lines: [] }))
  facts.recordInput('pty', 'driving', 'mine\r')
  await facts.observeInputScreen(
    'pty',
    Promise.resolve({ draft: '', model: {}, lines: ['› mine'] })
  )
  expect(facts.hasUnobservedInput('pty')).toBe(true)
  const unknown = new TerminalRunFactsRegister()
  unknown.recordInput('pty', 'driving', 'mine\r')
  await unknown.observeInputScreen('pty', Promise.resolve({ draft: '', lines: ['› mine'] }))
  expect(unknown.hasUnobservedInput('pty')).toBe(true)
})

it('observes Enter clearing its known composer even after the submitted row scrolls away', async () => {
  const facts = new TerminalRunFactsRegister()
  facts.setInputScreenReader(async () => ({ draft: 'own painted text', lines: [] }))
  facts.recordInput('pty', 'driving', '\r')
  await facts.observeInputScreen(
    'pty',
    Promise.resolve({ draft: 'own painted text', lines: ['unrelated output'] })
  )
  expect(facts.hasUnobservedInput('pty')).toBe(true)
  await facts.observeInputScreen('pty', Promise.resolve({ draft: '', lines: ['long answer tail'] }))
  expect(facts.hasUnobservedInput('pty')).toBe(false)
})
