import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  parseAndroidMobileWebActivation,
  readAndroidRollbackActivation,
  readSingleAndroidActivation
} from '../../scripts/hosted-android-mobile-web-cache.mjs'

const active = 'a'.repeat(64)
const previous = 'b'.repeat(64)
const harnessSource = readFileSync(
  new URL('../../scripts/run-hosted-android-corrupt-cache.mjs', import.meta.url),
  'utf8'
)

describe('hosted Android mobile web cache evidence', () => {
  it('normalizes an omitted previous generation and rejects invalid identities', () => {
    expect(parseAndroidMobileWebActivation(JSON.stringify({ active }))).toEqual({
      active,
      previous: null
    })
    expect(() => parseAndroidMobileWebActivation(JSON.stringify({ active: '../active' }))).toThrow(
      'Android cache returned an invalid activation record'
    )
  })

  it('selects the only rollback candidate', async () => {
    const runAdb = activationExecutor([
      ['cache/one/activation.json', { active }],
      ['cache/two/activation.json', { active, previous }]
    ])

    await expect(readAndroidRollbackActivation('adb', runAdb)).resolves.toEqual({
      path: 'cache/two/activation.json',
      active,
      previous
    })
  })

  it('requires exactly one activation record for corruption drills', async () => {
    const runAdb = activationExecutor([['cache/one/activation.json', { active }]])

    await expect(readSingleAndroidActivation('adb', runAdb)).resolves.toEqual({
      path: 'cache/one/activation.json',
      active,
      previous: null
    })
  })

  it('keeps the offline corruption drill bounded and reversible', () => {
    expect(harnessSource).toContain("process.kill(options.desktopPid, 'SIGSTOP')")
    expect(harnessSource).toContain("process.kill(options.desktopPid, 'SIGCONT')")
    expect(harnessSource).toContain('repairFixture(')
    expect(harnessSource).toContain('requireGenerationRemoved(')
    expect(harnessSource).toContain('expectedText: options.expectedText')
  })
})

function activationExecutor(records: [string, { active: string; previous?: string }][]) {
  return vi.fn(async (_command: string, args: string[]) => {
    if (args.includes('find')) {
      return records.map(([path]) => path).join('\n')
    }
    const path = args.at(-1)
    const record = records.find(([candidate]) => candidate === path)?.[1]
    if (!record) {
      throw new Error('unexpected Android activation path')
    }
    return JSON.stringify(record)
  })
}
