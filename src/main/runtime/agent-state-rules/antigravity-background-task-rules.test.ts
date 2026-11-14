import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HeadlessEmulator } from '../../daemon/emulation/headless-emulator'
import { visibleNonBlankTerminalLines } from '../terminal/output/tail/terminal-tail-read'
import { evaluateAgentStateRules } from './agent-state-rules-engine'

async function verdictFor(fixture: string) {
  const emulator = new HeadlessEmulator({ cols: 120, rows: 40 })
  await emulator.write(
    readFileSync(join(__dirname, '..', '__fixtures__', `${fixture}.txt`), 'utf8')
  )
  const lines = visibleNonBlankTerminalLines(emulator.getVisibleLines())
  emulator.dispose()
  return evaluateAgentStateRules('antigravity', { readScreenLines: () => lines })
}

describe('antigravity composer with background task rows', () => {
  it.each([
    'antigravity-1-4-11-ready-background-task',
    'antigravity-1-4-11-ready-two-background-tasks'
  ])('reads %s as a strong idle composer', async (fixture) => {
    expect(await verdictFor(fixture)).toMatchObject({ state: 'idle', strength: 'strong' })
  })

  it.each([
    'antigravity-1-4-11-busy-with-background-task',
    'antigravity-1-4-11-draft-with-background-task'
  ])('holds %s', async (fixture) => {
    expect(await verdictFor(fixture)).toMatchObject({ state: 'hold' })
  })
})
