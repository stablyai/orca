import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAESTRO_HANDLERS } from './handlers/maestro'
import { readJsonObjectInput, readStructuredInput } from './structured-input'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-cli-input-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('structured CLI input', () => {
  it('reads a relative file on the CLI host', async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, 'task.txt'), 'Inspect literal $(payload).', 'utf8')

    await expect(
      readStructuredInput({
        flags: new Map([['spec-file', 'task.txt']]),
        cwd,
        inlineFlag: 'spec',
        fileFlag: 'spec-file',
        label: 'Task spec'
      })
    ).resolves.toBe('Inspect literal $(payload).')
  })

  it('rejects ambiguous and empty input', async () => {
    await expect(
      readStructuredInput({
        flags: new Map([
          ['spec', 'inline'],
          ['spec-file', 'task.txt']
        ]),
        cwd: '/repo',
        inlineFlag: 'spec',
        fileFlag: 'spec-file',
        label: 'Task spec'
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' })

    await expect(
      readStructuredInput({
        flags: new Map([['spec', '   ']]),
        cwd: '/repo',
        inlineFlag: 'spec',
        fileFlag: 'spec-file',
        label: 'Task spec'
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('rejects invalid UTF-8 and non-object JSON', async () => {
    const cwd = await temporaryDirectory()
    await writeFile(join(cwd, 'invalid.json'), Buffer.from([0xc3, 0x28]))

    await expect(
      readJsonObjectInput({
        flags: new Map([['payload-file', 'invalid.json']]),
        cwd,
        inlineFlag: 'payload',
        fileFlag: 'payload-file',
        label: 'Maestro payload'
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' })

    await expect(
      readJsonObjectInput({
        flags: new Map([['payload', '[]']]),
        cwd,
        inlineFlag: 'payload',
        fileFlag: 'payload-file',
        label: 'Maestro payload'
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('validates JSON before calling the runtime', async () => {
    const call = vi.fn()
    await expect(
      MAESTRO_HANDLERS['maestro projection apply']({
        flags: new Map([['payload', '{invalid']]),
        client: { call },
        cwd: '/repo',
        json: true
      } as never)
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })
})
