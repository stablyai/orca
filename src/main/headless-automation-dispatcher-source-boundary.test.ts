import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')

function sourceBetween(startPattern: string, endPattern: string): string {
  const start = source.indexOf(startPattern)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endPattern, start + startPattern.length)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('headless automation dispatcher source boundaries', () => {
  it('creates new-per-run workspaces from the resolved run target repo', () => {
    const createArgsSection = sourceBetween('buildHeadlessAutomationWorktreeCreateArgs({', '})')

    expect(createArgsSection).toContain('repo: target.repo')
    expect(createArgsSection).not.toContain('automation.sourceContext')
  })
})
