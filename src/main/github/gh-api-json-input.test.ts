import { readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withGhApiJsonInput } from './gh-api-json-input'

describe('withGhApiJsonInput', () => {
  it('writes the payload to a temp JSON file and passes --input', async () => {
    let inputPath = ''
    const result = await withGhApiJsonInput(
      { title: 'Bug', body: 'hello\nworld', labels: ['bug'] },
      async (inputArgs) => {
        expect(inputArgs[0]).toBe('--input')
        expect(inputArgs[1]).not.toBe('-')
        inputPath = inputArgs[1]
        expect(JSON.parse(await readFile(inputPath, 'utf8'))).toEqual({
          title: 'Bug',
          body: 'hello\nworld',
          labels: ['bug']
        })
        return 42
      }
    )
    expect(result).toBe(42)
    await expect(readFile(inputPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(dirname(inputPath))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('deletes the temp JSON file when run throws', async () => {
    let inputPath = ''
    await expect(
      withGhApiJsonInput({ body: 'payload' }, async (inputArgs) => {
        inputPath = inputArgs[1]
        expect(JSON.parse(await readFile(inputPath, 'utf8'))).toEqual({ body: 'payload' })
        throw new Error('gh failed')
      })
    ).rejects.toThrow('gh failed')
    await expect(readFile(inputPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
