import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ComposioCleanup } from './composio-cleanup'

describe('ComposioCleanup', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-composio-cleanup-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not replace a cleanup list it could not read', () => {
    const file = join(dir, 'composio-pending-cleanup.json')
    const truncated = '{"bots":[{"botId":"bot-a","project":"project-a"}]}'.slice(0, -4)
    writeFileSync(file, truncated)

    new ComposioCleanup(file).add({ botId: 'bot-b', project: null })

    expect(readFileSync(file, 'utf8')).toBe(truncated)
  })

  it('still records a bot when there is no list yet', () => {
    const file = join(dir, 'composio-pending-cleanup.json')

    new ComposioCleanup(file).add({ botId: 'bot-a', project: null })

    expect(new ComposioCleanup(file).pending()).toEqual([{ botId: 'bot-a', project: null }])
  })
})
