import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ComposioIngressStore } from './composio-events-ingress'

describe('ComposioIngressStore', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-composio-events-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not drop a project from an ingress store it could not read', () => {
    const file = join(dir, 'composio-events.json')
    const truncated =
      '{"projects":{"project-a":{"automationId":"automation-a","hookId":"hook-a","signed":true}}}'.slice(
        0,
        -6
      )
    writeFileSync(file, truncated)

    new ComposioIngressStore(file).write('project-b', {
      automationId: 'automation-b',
      hookId: 'hook-b',
      signed: true
    })

    expect(readFileSync(file, 'utf8')).toBe(truncated)
  })
})
