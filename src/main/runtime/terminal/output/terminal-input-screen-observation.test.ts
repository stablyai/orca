import { expect, it } from 'vitest'
import { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import { TerminalRunFactsRegister } from '../lifecycle/terminal-run-facts'
import { captureTerminalInputScreen } from './terminal-input-screen-observation'
import { reserveEmptyTerminalDraft } from '../../rpc/methods/terminal/terminal-empty-draft-reservation'

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

it.each([
  '\x1b[D',
  '\x1bOD',
  '\x1b[H',
  '\x1b[3~',
  '\t',
  '\x17',
  '\x03',
  '\x1b[<0;4;2M',
  '\x1b[M !!'
])('recovers opaque input %j only after a new matching submission paints', async (control) => {
  const emulator = new HeadlessEmulator({ cols: 80, rows: 16 })
  const state = { emulator, writeChain: Promise.resolve() }
  const facts = new TerminalRunFactsRegister()
  facts.setInputScreenReader(() => captureTerminalInputScreen(state))
  const old = '❯ edited\r\nold answer\r\n'
  try {
    await emulator.write(frame('edited', old))
    facts.recordInput('pty', 'driving', control)
    await facts.observeInputScreen('pty', captureTerminalInputScreen(state))
    expect(facts.hasUnobservedInput('pty')).toBe(true)
    facts.recordInput('pty', 'driving', '\r')
    state.writeChain = state.writeChain.then(() => emulator.write(frame('', old)))
    await facts.observeInputScreen('pty', captureTerminalInputScreen(state))
    expect(facts.hasUnobservedInput('pty')).toBe(true)
    state.writeChain = state.writeChain.then(() =>
      emulator.write(frame('', `${old}❯ edited\r\nnew answer\r\n`))
    )
    await facts.observeInputScreen('pty', captureTerminalInputScreen(state))
    expect(facts.hasUnobservedInput('pty')).toBe(false)
    const reserve = await reserveEmptyTerminalDraft(
      {
        terminalRunFacts: facts,
        getTerminalPromptRequestBinding: () => ({
          ptyId: 'pty',
          processIncarnation: 'process',
          generation: 1
        }),
        readTerminal: async () => {
          const painted = await captureTerminalInputScreen(state)
          return { source: 'screen', ...(painted.draft === null ? {} : { draft: painted.draft }) }
        }
      },
      'terminal'
    )
    expect(() => reserve('pty')).not.toThrow()
  } finally {
    emulator.dispose()
  }
})

it('recovers a later ordinary submission even when the opaque edit and Enter shared a write', async () => {
  const facts = new TerminalRunFactsRegister()
  let screen: { draft: string; lines: string[] } = { draft: '', lines: [] }
  facts.setInputScreenReader(async () => screen)
  facts.recordInput('pty', 'driving', '\x1b[Dedited\r')
  screen = { draft: '', lines: ['› edited'] }
  await facts.observeInputScreen('pty', Promise.resolve(screen))
  expect(facts.hasUnobservedInput('pty')).toBe(true)
  facts.recordInput('pty', 'driving', 'next\r')
  await facts.observeInputScreen('pty', Promise.resolve(screen))
  expect(facts.hasUnobservedInput('pty')).toBe(true)
  await facts.observeInputScreen(
    'pty',
    Promise.resolve({ draft: '', lines: ['› edited', '› next'] })
  )
  expect(facts.hasUnobservedInput('pty')).toBe(false)
})

it.each([
  ['\x1b[', 'D'],
  ['\x1bO', 'D'],
  ['\x1b[M', '\r\x15a'],
  ['\x1b]title', '\x07'],
  ['\x1b]title\x1b', '\\'],
  ['\x1bPpayload\r\x15', '\x1b\\']
])('keeps split control framing intact through %j then %j', async (start, end) => {
  const facts = new TerminalRunFactsRegister()
  const screen: { draft: string; lines: string[] } = { draft: 'painted', lines: [] }
  facts.setInputScreenReader(async () => screen)
  for (const data of [start, end]) {
    facts.recordInput('pty', 'driving', data)
    await facts.observeInputScreen('pty', Promise.resolve({ draft: '', lines: ['› a'] }))
    expect(facts.hasUnobservedInput('pty')).toBe(true)
  }
  facts.recordInput('pty', 'driving', '\r')
  await facts.observeInputScreen('pty', Promise.resolve({ draft: '', lines: ['› painted'] }))
  expect(facts.hasUnobservedInput('pty')).toBe(false)
})

it('preserves split paste delimiters and does not submit or reset on pasted control bytes', async () => {
  const facts = new TerminalRunFactsRegister()
  facts.setInputScreenReader(async () => ({ draft: '', lines: [] }))
  for (const data of ['\x1b[20', '0~first\r\x15second', '\x1b[201', '~']) {
    facts.recordInput('pty', 'driving', data)
    await facts.observeInputScreen('pty', Promise.resolve({ draft: '', lines: ['› second'] }))
    expect(facts.hasUnobservedInput('pty')).toBe(true)
  }
  facts.recordInput('pty', 'driving', 'fresh\r')
  await facts.observeInputScreen('pty', Promise.resolve({ draft: '', lines: ['› fresh'] }))
  expect(facts.hasUnobservedInput('pty')).toBe(false)
})

it('does not treat Ctrl-U after unknown cursor editing as a known full-composer clear', async () => {
  const facts = new TerminalRunFactsRegister()
  facts.setInputScreenReader(async () => ({ draft: 'suffix', lines: [] }))
  facts.recordInput('pty', 'driving', '\x1b[D\x15')
  await facts.observeInputScreen('pty', Promise.resolve({ draft: '', lines: [] }))
  expect(facts.hasUnobservedInput('pty')).toBe(true)
})

it('does not recover opaque editing from a matching draft paint without a submission', async () => {
  const facts = new TerminalRunFactsRegister()
  let screen: { draft: string; lines: string[] } = { draft: 'painted', lines: [] }
  facts.setInputScreenReader(async () => screen)
  facts.recordInput('pty', 'driving', '\x1b[D')
  await facts.observeInputScreen('pty', Promise.resolve(screen))
  facts.recordInput('pty', 'driving', ' suffix')
  screen = { draft: 'painted suffix', lines: [] }
  await facts.observeInputScreen('pty', Promise.resolve(screen))
  expect(facts.hasUnobservedInput('pty')).toBe(true)
  facts.recordInput('pty', 'driving', '\r')
  await facts.observeInputScreen('pty', Promise.resolve({ draft: '', lines: ['› painted suffix'] }))
  expect(facts.hasUnobservedInput('pty')).toBe(false)
})

it('waits for queued old paints when taking the recovery baseline', async () => {
  const emulator = new HeadlessEmulator({ cols: 80, rows: 16 })
  const state = { emulator, writeChain: Promise.resolve() }
  const facts = new TerminalRunFactsRegister()
  facts.setInputScreenReader(() => captureTerminalInputScreen(state))
  try {
    await emulator.write(frame('edited'))
    facts.recordInput('pty', 'driving', '\x1b[D')
    await facts.observeInputScreen('pty', captureTerminalInputScreen(state))
    state.writeChain = emulator.write(frame('edited', '❯ edited\r\nold answer\r\n'))
    facts.recordInput('pty', 'driving', '\r')
    state.writeChain = state.writeChain.then(() =>
      emulator.write(frame('', '❯ edited\r\nold answer\r\n'))
    )
    await facts.observeInputScreen('pty', captureTerminalInputScreen(state))
    expect(facts.hasUnobservedInput('pty')).toBe(true)
  } finally {
    emulator.dispose()
  }
})
