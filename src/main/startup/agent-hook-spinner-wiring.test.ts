import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('agent hook spinner wiring', () => {
  it('stops the pane spinner when its live hook status is dropped', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'main', 'index.ts'), 'utf8')

    expect(source).toContain('agentHookServer.subscribeStatusDrop(stopSyntheticTitleSpinner)')
  })
})
