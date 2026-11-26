import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeTerminalWriter } from './runtime-terminal-writer'
import { writeTerminalSendForReceipt } from './terminal-send-receipt'
import { TerminalRunFactsRegister } from '../lifecycle/terminal-run-facts'
import {
  WRITE_ACCEPTED,
  writeRefused
} from '../../../../shared/terminal/pty/lifecycle/pty-write-settlement'

afterEach(() => vi.useRealTimers())

it('ends the in-flight fence after a refused write without claiming ingestion', async () => {
  const facts = new TerminalRunFactsRegister()
  const writer = new RuntimeTerminalWriter(
    () => true,
    () => 'win32',
    () => 'antigravity'
  )
  const text = 'note\n'.repeat(30_000)
  const receipt = await writeTerminalSendForReceipt(
    { writer, runFacts: facts, writeAction: async () => writeRefused('provider_cannot_settle') },
    {
      handle: 'term',
      ptyId: 'pty',
      action: { text },
      payload: text,
      options: { clientSubmit: true, inputKind: 'driving' }
    }
  )
  expect(receipt.accepted).toBe(false)
  facts.recordInput('pty', 'driving', '\r')
  expect(facts.readResolvedInputGeneration('pty')).not.toBe(0)
})

it('keeps ingestion protected after a partial write loses settlement, then releases the in-flight fence', async () => {
  vi.useFakeTimers()
  const facts = new TerminalRunFactsRegister()
  let handedOff = false
  const writer = new RuntimeTerminalWriter(
    () => true,
    () => 'win32',
    () => 'antigravity',
    (_id, data) => {
      if (handedOff) {
        throw new Error('lost settlement')
      }
      handedOff = true
      facts.recordInput('pty', 'driving', data)
      return WRITE_ACCEPTED
    }
  )
  const text = 'note\n'.repeat(30_000)
  const pending = writeTerminalSendForReceipt(
    {
      writer,
      runFacts: facts,
      writeAction: (options) => writer.writeAction('pty', { text }, text, options)
    },
    {
      handle: 'term',
      ptyId: 'pty',
      action: { text },
      payload: text,
      options: { clientSubmit: true, inputKind: 'driving', requireWriteSettlement: true }
    }
  )
  await vi.runAllTimersAsync()
  await expect(pending).resolves.toMatchObject({
    accepted: false,
    writeSettlement: { outcome: 'unverifiable' }
  })
  facts.recordInput('pty', 'driving', '\r')
  expect(facts.readResolvedInputGeneration('pty')).toBe(0)
  await vi.advanceTimersByTimeAsync(86_400_000)
  facts.recordInput('pty', 'driving', '\r')
  expect(facts.readResolvedInputGeneration('pty')).not.toBe(0)
})

it('does not carry an old pending write fence into a retired terminal', async () => {
  const facts = new TerminalRunFactsRegister()
  const writer = new RuntimeTerminalWriter(
    () => true,
    () => 'win32',
    () => 'antigravity'
  )
  const text = 'note\n'.repeat(30_000)
  await writeTerminalSendForReceipt(
    {
      writer,
      runFacts: facts,
      writeAction: async () => {
        facts.delete('pty')
        return undefined
      }
    },
    {
      handle: 'term',
      ptyId: 'pty',
      action: { text },
      payload: text,
      options: { clientSubmit: true, inputKind: 'driving' }
    }
  )
  facts.recordInput('pty', 'driving', '\r')
  expect(facts.readResolvedInputGeneration('pty')).not.toBe(0)
})

it('cleans up the pending fence if delay calculation fails before a write', async () => {
  const facts = new TerminalRunFactsRegister()
  const writer = new RuntimeTerminalWriter(
    () => true,
    () => {
      throw new Error('platform unavailable')
    }
  )
  await expect(
    writeTerminalSendForReceipt(
      { writer, runFacts: facts, writeAction: async () => undefined },
      {
        handle: 'term',
        ptyId: 'pty',
        action: { text: 'note' },
        payload: 'note',
        options: { clientSubmit: true, inputKind: 'driving' }
      }
    )
  ).rejects.toThrow('platform unavailable')
  facts.recordInput('pty', 'driving', '\r')
  expect(facts.readResolvedInputGeneration('pty')).not.toBe(0)
})
