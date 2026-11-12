import { readFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runTypecheckProjects } from './run-typecheck-projects-in-parallel.mjs'

describe('local and CI compiler selection', () => {
  it('continues to later projects after a compiler exits with an error', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-typecheck-failure-')))
    try {
      const compilerDir = join(root, 'node_modules', 'typescript')
      mkdirSync(compilerDir, { recursive: true })
      mkdirSync(join(root, 'config'))
      writeFileSync(
        join(compilerDir, 'package.json'),
        JSON.stringify({ name: 'typescript', bin: { tsc: 'compiler.cjs' } })
      )
      writeFileSync(
        join(compilerDir, 'compiler.cjs'),
        "const fs = require('node:fs'); const config = process.argv.at(-1); fs.appendFileSync('checked.txt', config + '\\n'); process.exit(config.includes('broken') ? 1 : 0)"
      )
      const failures = await runTypecheckProjects({
        root,
        projects: [
          { config: 'config/broken.json', heapGib: 1 },
          { config: 'config/healthy.json', heapGib: 1 }
        ],
        memoryBytes: 2 * 1024 ** 3,
        parallelism: 1
      })
      expect(failures).toHaveLength(1)
      expect(failures[0].message).toContain('broken.json exited with code 1')
      expect(readFileSync(join(root, 'checked.txt'), 'utf8')).toBe(
        'config/broken.json\nconfig/healthy.json\n'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
