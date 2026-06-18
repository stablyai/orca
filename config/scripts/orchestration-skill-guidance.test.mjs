import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const skillPath = join(projectDir, 'skills', 'orchestration', 'SKILL.md')

describe('orchestration skill guidance', () => {
  it('treats long-running worker waits as liveness checkpoints, not failures', () => {
    const skill = readFileSync(skillPath, 'utf8')

    expect(skill).toContain('Treat a `check --wait` timeout or `{count:0}` as a checkpoint')
    expect(skill).toContain('Do not stop, close, kill, or restart a worker')
    expect(skill).toContain('keep waiting instead of retrying the task')
    expect(skill).not.toContain(
      'If `check --wait` times out with no `worker_done` or `escalation`, fall back to `terminal wait --for tui-idle`, then `terminal read`.'
    )
  })
})
