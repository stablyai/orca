import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CURSOR_OPENING_RULE_FILE, placeCursorOpeningRule } from './cursor-opening-rule'

let home = ''
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'cursor-opening-rule-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const rulePath = () => join(home, '.cursor', 'rules', CURSOR_OPENING_RULE_FILE)

describe('Cursor opening rule', () => {
  it("leaves the folder's own rules alone", async () => {
    await mkdir(join(home, '.cursor', 'rules'), { recursive: true })
    await writeFile(join(home, '.cursor', 'rules', 'mine.mdc'), 'mine')
    const undo = await placeCursorOpeningRule(home, 'You are Zorblax.')
    await undo()
    expect(await readdir(join(home, '.cursor', 'rules'))).toEqual(['mine.mdc'])
  })

  it('holds a second open in the same folder until the first is undone', async () => {
    const first = await placeCursorOpeningRule(home, 'first')
    let secondPlaced = false
    const second = placeCursorOpeningRule(home, 'second').then((undo) => {
      secondPlaced = true
      return undo
    })
    // The second open waits on the first's undo before touching the folder, so nothing else can move it.
    expect(secondPlaced).toBe(false)
    expect(await readFile(rulePath(), 'utf8')).toContain('first')
    await first()
    const undoSecond = await second
    expect(await readFile(rulePath(), 'utf8')).toContain('second')
    await undoSecond()
    expect(await readdir(home)).toEqual([])
  })
})
