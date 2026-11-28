import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withAcpSessionOpen } from './acp-instructions'
import { deliverVibeInstructions } from './acp-instructions-vibe'

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'acp-instructions-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const launchFor = async (text: string) => {
  const delivered = await deliverVibeInstructions.launch({
    text,
    file: async () => '',
    folder: async () => '',
    emptyFolder: async () => '',
    env: {},
    cwd: dir,
    version: null
  })
  if (!delivered?.aroundSessionOpen) {
    throw new Error('vibe delivery must always return aroundSessionOpen')
  }
  return delivered
}

describe('deliverVibeInstructions', () => {
  it('writes the block before the open and removes it on undo', async () => {
    const launch = await launchFor('standing rules')
    const undo = await launch.aroundSessionOpen!(dir)
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toContain('standing rules')
    await undo()
    // The file was Orca-written, so removal deletes it whole.
    await expect(readFile(join(dir, 'AGENTS.md'), 'utf8')).rejects.toThrow()
  })

  it('an instruction-less open clears a stale block left by a failed cleanup', async () => {
    await writeFile(
      join(dir, 'AGENTS.md'),
      '<!-- Orca writes this file for Mistral Vibe chats in this folder; edits are replaced. -->\n\nold chat rules\n'
    )
    const launch = await launchFor('')
    const undo = await launch.aroundSessionOpen!(dir)
    await expect(readFile(join(dir, 'AGENTS.md'), 'utf8')).rejects.toThrow()
    await undo()
  })

  it('serializes opens in nested folders on the shared parent AGENTS.md slot', async () => {
    const sub = join(dir, 'sub')
    await mkdir(sub)
    const first = await launchFor('first rules')
    const undoFirst = await first.aroundSessionOpen!(dir)
    let secondOpened = false
    const second = launchFor('second rules').then(async (launch) => {
      const undo = await launch.aroundSessionOpen!(sub)
      secondOpened = true
      return undo
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(secondOpened).toBe(false)
    await undoFirst()
    const undoSecond = await second
    expect(secondOpened).toBe(true)
    await undoSecond()
  })
})

describe('withAcpSessionOpen', () => {
  it('releases what the open placed when the signal aborts a hung open', async () => {
    const controller = new AbortController()
    const launch = await launchFor('rules')
    const promise = withAcpSessionOpen(
      launch,
      dir,
      () => new Promise<void>(() => {}),
      controller.signal
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toContain('rules')
    controller.abort(new Error('stop'))
    await expect(promise).rejects.toThrow('stop')
    await expect(readFile(join(dir, 'AGENTS.md'), 'utf8')).rejects.toThrow()
  })
})
