import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { publishClaudeConversationTranscript } from './claude-conversation-transcript-publication'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-transcript-publication-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('writes each entry before serializing the next and publishes only the complete transcript', async () => {
  const temporary = join(root, 'owned.tmp')
  const destination = join(root, 'child.jsonl')
  await publishClaudeConversationTranscript(temporary, destination, [
    { type: 'user', uuid: 'first' },
    {
      toJSON() {
        expect(readFileSync(temporary, 'utf8')).toBe('{"type":"user","uuid":"first"}\n')
        expect(existsSync(destination)).toBe(false)
        return { type: 'assistant', uuid: 'second' }
      }
    }
  ])
  expect(await readFile(destination, 'utf8')).toBe(
    '{"type":"user","uuid":"first"}\n{"type":"assistant","uuid":"second"}\n'
  )
  expect(existsSync(temporary)).toBe(false)
  if (process.platform !== 'win32') {
    expect((await stat(destination)).mode & 0o777).toBe(0o600)
  }
})

it('removes an incomplete owned temp without publishing or replacing a destination', async () => {
  const temporary = join(root, 'owned.tmp')
  const destination = join(root, 'child.jsonl')
  await writeFile(destination, 'existing transcript\n')
  await expect(
    publishClaudeConversationTranscript(temporary, destination, [
      { type: 'user', uuid: 'first' },
      {
        toJSON() {
          throw new Error('serialization failed')
        }
      }
    ])
  ).rejects.toThrow('serialization failed')
  expect(existsSync(temporary)).toBe(false)
  expect(await readFile(destination, 'utf8')).toBe('existing transcript\n')
})

it('removes the fsynced temp when publishing the copy fails', async () => {
  const temporary = join(root, 'owned.tmp')
  const destination = join(root, 'existing-directory')
  await mkdir(destination)
  await writeFile(join(destination, 'kept'), 'existing data')
  await expect(
    publishClaudeConversationTranscript(temporary, destination, [{ type: 'user', uuid: 'first' }])
  ).rejects.toThrow()
  expect(existsSync(temporary)).toBe(false)
  expect(await readFile(join(destination, 'kept'), 'utf8')).toBe('existing data')
})
