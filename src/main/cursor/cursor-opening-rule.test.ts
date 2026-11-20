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

  it('keeps a user rule saved under the same name and removes only its own', async () => {
    await mkdir(join(home, '.cursor', 'rules'), { recursive: true })
    await writeFile(rulePath(), 'my own rule')
    const undo = await placeCursorOpeningRule(home, 'You are Zorblax.')
    expect(await readFile(rulePath(), 'utf8')).toBe('my own rule')
    expect(await readdir(join(home, '.cursor', 'rules'))).toHaveLength(2)
    await undo()
    expect(await readFile(rulePath(), 'utf8')).toBe('my own rule')
    expect(await readdir(join(home, '.cursor', 'rules'))).toHaveLength(1)
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

  it('keeps a user file with the Orca header under a non-UUID sibling name', async () => {
    const rules = join(home, '.cursor', 'rules')
    await mkdir(rules, { recursive: true })
    await writeFile(rulePath(), 'my own rule')
    const copy = `orca-standing-instructions-${'a'.repeat(36)}.mdc`
    const body = "---\ndescription: Orca's standing instructions for this chat\nmine\n"
    await writeFile(join(rules, copy), body)
    const undo = await placeCursorOpeningRule(home, 'text')
    expect(await readFile(join(rules, copy), 'utf8')).toBe(body)
    await undo()
  })

  it('holds opens that spell the same folder differently', async () => {
    const first = await placeCursorOpeningRule(home, 'first')
    let secondPlaced = false
    const second = placeCursorOpeningRule(`${home}/`, 'second').then((undo) => {
      secondPlaced = true
      return undo
    })
    await Promise.resolve()
    expect(secondPlaced).toBe(false)
    await first()
    await (
      await second
    )()
  })
})
