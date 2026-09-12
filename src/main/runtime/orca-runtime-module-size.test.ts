import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const MAX_RUNTIME_MODULE_LINES = 400

function runtimeImplementationModuleNames(): string[] {
  return readdirSync(import.meta.dirname)
    .filter(
      (name) =>
        name.endsWith('.ts') &&
        !name.includes('.test.') &&
        !name.includes('.spec.') &&
        // Every `runtime-*` split module, not just the orca-runtime-* ones: the
        // un-prefixed siblings (runtime-pty-*, runtime-worktree-*, …) carry split
        // runtime code too, and an extraction into one of them used to escape this gate.
        (name === 'orca-runtime.ts' ||
          name.startsWith('orca-runtime-') ||
          name.startsWith('runtime-'))
    )
    .sort()
}

describe('Orca runtime module size', () => {
  it('keeps every split implementation module at or below 400 physical lines', () => {
    const oversized = runtimeImplementationModuleNames().flatMap((name) => {
      const lines = readFileSync(join(import.meta.dirname, name), 'utf8').split(/\r?\n/).length
      return lines > MAX_RUNTIME_MODULE_LINES ? [`${name}: ${lines}`] : []
    })

    expect(oversized).toEqual([])
  })
})
