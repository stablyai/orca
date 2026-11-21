import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
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
const rulesDir = () => join(home, '.cursor', 'rules')
async function placedRule(): Promise<string> {
  const names = (await readdir(rulesDir())).filter((name) =>
    name.startsWith('orca-standing-instructions')
  )
  expect(names).toHaveLength(1)
  return join(rulesDir(), names[0])
}

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

  it('never overwrites a customized rule under the old fixed name', async () => {
    await mkdir(rulesDir(), { recursive: true })
    const custom =
      "---\ndescription: Orca's standing instructions for this chat\nalwaysApply: true\n---\nmy edits\n"
    await writeFile(rulePath(), custom)
    const undo = await placeCursorOpeningRule(home, 'You are Zorblax.')
    expect(await readFile(rulePath(), 'utf8')).toBe(custom)
    await undo()
    expect(await readFile(rulePath(), 'utf8')).toBe(custom)
  })

  it('keeps an edit the user made to the rule while the session opened', async () => {
    const undo = await placeCursorOpeningRule(home, 'You are Zorblax.')
    const placed = await placedRule()
    const edited = `${await readFile(placed, 'utf8')}and keep this\n`
    await writeFile(placed, edited)
    await undo()
    expect(await readFile(placed, 'utf8')).toBe(edited)
  })

  it('sweeps an old unchanged leftover but keeps an edited one', async () => {
    await mkdir(rulesDir(), { recursive: true })
    await writeFile(join(rulesDir(), 'mine.mdc'), 'mine')
    const undoCrashed = await placeCursorOpeningRule(home, 'crashed')
    const leftover = await placedRule()
    await undoCrashed()
    const editedUndo = await placeCursorOpeningRule(home, 'edited')
    const edited = await placedRule()
    await editedUndo()
    // Recreate both as a crash would have left them, one with the user's edit.
    await writeFile(
      leftover,
      "---\ndescription: Orca's standing instructions for this chat\nalwaysApply: true\n---\ncrashed\n"
    )
    await writeFile(edited, 'my edits\n')
    const longAgo = new Date(0)
    await utimes(leftover, longAgo, longAgo)
    await utimes(edited, longAgo, longAgo)

    const undo = await placeCursorOpeningRule(home, 'next')
    await undo()

    expect((await readdir(rulesDir())).sort()).toEqual(['mine.mdc', edited.split('/').pop()].sort())
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
    expect(await readFile(await placedRule(), 'utf8')).toContain('first')
    await first()
    const undoSecond = await second
    expect(await readFile(await placedRule(), 'utf8')).toContain('second')
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
