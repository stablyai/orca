import {
  appendFile,
  mkdtemp,
  rename,
  rm,
  truncate,
  utimes,
  stat,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { importClaudeTranscript, type ClaudeImportInput } from './journal-claude-import'
import { assertAdoptedSourceIdentity } from './adopted-transcript-source'
import { ClaudeImportSource, type ClaudeRange } from './journal-claude-import-source'
import { ClaudeImportResourceError } from './journal-claude-import-resource-error'

let root: string | undefined
const entry = (uuid: string, parentUuid: string | null, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  uuid,
  parentUuid,
  sessionId: 'session',
  message: { content: uuid },
  ...extra
})
async function transcript(rows: unknown[]): Promise<ClaudeImportInput> {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-source-'))
  const filePath = join(root, 'session.jsonl')
  await writeFile(filePath, rows.map((row) => `${JSON.stringify(row)}\n`).join(''))
  return {
    filePath,
    agent: 'claude',
    sessionId: 'session',
    retainedBytes: 16384,
    limits: { inlineHeadBytes: 16384 }
  }
}
afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it('does not verify a candidate that has grown past the indexed length', async () => {
  const input = await transcript([entry('old', null), entry('answer', 'old')])
  const result = await importClaudeTranscript(input)
  try {
    await appendFile(input.filePath, `${JSON.stringify(entry('append', 'answer'))}\n`)
    await expect(result.verify()).rejects.toThrow('Claude transcript grew during history import.')
  } finally {
    await result.close()
  }
})

it.each(['truncation', 'replacement'] as const)(
  'refuses %s of the snapshot before publication',
  async (change) => {
    const input = await transcript([entry('a', null)])
    const result = await importClaudeTranscript(input)
    try {
      if (change === 'truncation') {
        await truncate(input.filePath, 0)
      } else {
        await rename(input.filePath, `${input.filePath}.old`)
        await writeFile(input.filePath, `${JSON.stringify(entry('a', null))}\n`)
      }
      await expect(result.verify()).rejects.toThrow(ClaudeImportResourceError)
    } finally {
      await result.close()
    }
  }
)

it('refuses a rewritten selected row during the offset reread', async () => {
  const input = await transcript([entry('root', null)])
  const source = await ClaudeImportSource.open(input.filePath)
  try {
    const ranges: ClaudeRange[] = []
    await source.scan((_, range) => {
      ranges.push(range)
    })
    await writeFile(input.filePath, `${JSON.stringify(entry('edit', null))}\n`)
    await expect(source.reread(ranges).next()).rejects.toThrow(ClaudeImportResourceError)
  } finally {
    await source.close()
  }
})

it('validates adoption using the requested agent identity', async () => {
  const input = await transcript([entry('root', null)])
  const workspaceCwd = root!
  const source = { providerSessionId: 'session', workspaceCwd }
  await writeFile(input.filePath, JSON.stringify(entry('root', null, { cwd: workspaceCwd })))
  async function validate(agent: ClaudeImportInput['agent']) {
    const imported = await importClaudeTranscript({ ...input, agent, source })
    try {
      await assertAdoptedSourceIdentity(source, imported.identity!)
    } finally {
      await imported.close()
    }
  }
  await validate('claude')
  await expect(validate('openclaude')).rejects.toThrow(
    'The saved conversation does not match the requested provider identity.'
  )
})

it('proves the full prefix even when an edit leaves the selected rows and size intact', async () => {
  const input = await transcript([
    entry('root', null),
    entry('lost', 'root'),
    entry('answer', 'root')
  ])
  const initial = await stat(input.filePath)
  const result = await importClaudeTranscript(input)
  try {
    await writeFile(
      input.filePath,
      [entry('root', null), entry('lost', 'xxxx'), entry('answer', 'root')]
        .map((row) => `${JSON.stringify(row)}\n`)
        .join('')
    )
    await utimes(input.filePath, initial.atime, initial.mtime)
    await expect(result.verify()).rejects.toThrow(ClaudeImportResourceError)
  } finally {
    await result.close()
  }
})
