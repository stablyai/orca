import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyCliRequireResolution } from './verify-cli-require-resolution.mjs'

const tempDirs = []

function makeProject(files) {
  const projectDir = mkdtempSync(path.join(tmpdir(), 'orca-cli-requires-'))
  tempDirs.push(projectDir)
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(projectDir, relativePath)
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(filePath, content, 'utf8')
  }
  return projectDir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true })
  }
})

describe('verifyCliRequireResolution', () => {
  it('passes when every relative require resolves in out/', () => {
    const projectDir = makeProject({
      'out/cli/index.js': `const a = require("./handlers/agent-hooks");`,
      'out/cli/handlers/agent-hooks.js': `require("../../shared/constants");`,
      'out/shared/constants.js': 'module.exports = {}'
    })
    const result = verifyCliRequireResolution({ projectDir })
    expect(result.missing).toEqual([])
    expect(result.checkedFiles).toBe(3)
  })

  it('reports a CLI require of a main module electron-vite removed', () => {
    // The 1.4.150-rc.1.perf shape: tsc emitted the module, electron-vite's
    // out/main clean deleted it, and the package shipped without it.
    const projectDir = makeProject({
      'out/cli/handlers/agent-hooks.js': `require("../../main/agent-launch/agent-catalog-schema-migration");`
    })
    const result = verifyCliRequireResolution({ projectDir })
    expect(result.missing).toEqual([
      {
        from: path.join('out', 'cli', 'handlers', 'agent-hooks.js'),
        specifier: '../../main/agent-launch/agent-catalog-schema-migration'
      }
    ])
  })

  it('follows transitive requires out of out/cli into out/shared', () => {
    const projectDir = makeProject({
      'out/cli/index.js': `require("../shared/session-key");`,
      'out/shared/session-key.js': `require("../main/deleted-by-clean");`
    })
    const result = verifyCliRequireResolution({ projectDir })
    expect(result.missing).toEqual([
      { from: path.join('out', 'shared', 'session-key.js'), specifier: '../main/deleted-by-clean' }
    ])
  })

  it('resolves directory index and json targets and ignores package requires', () => {
    const projectDir = makeProject({
      'out/cli/index.js': `
        require("./handlers");
        require("./config.json");
        require("commander");
      `,
      'out/cli/handlers/index.js': 'module.exports = {}',
      'out/cli/config.json': '{}'
    })
    const result = verifyCliRequireResolution({ projectDir })
    expect(result.missing).toEqual([])
  })

  it('ignores compiled specs that import main modules the shipped CLI never loads', () => {
    // serve-electron-flag-parity.test.ts imports a main module listed only for
    // typecheck parity; no CLI command can reach it.
    const projectDir = makeProject({
      'out/cli/index.js': 'module.exports = {}',
      'out/cli/serve-electron-flag-parity.test.js': `require("../main/startup/serve-mode-argv");`
    })
    const result = verifyCliRequireResolution({ projectDir })
    expect(result.missing).toEqual([])
    expect(result.checkedFiles).toBe(1)
  })

  it('still reports a spec pulled in by a real CLI entry', () => {
    const projectDir = makeProject({
      'out/cli/index.js': `require("./fixtures.test");`,
      'out/cli/fixtures.test.js': `require("../main/deleted-by-clean");`
    })
    const result = verifyCliRequireResolution({ projectDir })
    expect(result.missing).toEqual([
      { from: path.join('out', 'cli', 'fixtures.test.js'), specifier: '../main/deleted-by-clean' }
    ])
  })

  it('skips when out/cli has not been built', () => {
    const projectDir = makeProject({ 'out/main/index.js': '' })
    const result = verifyCliRequireResolution({ projectDir })
    expect(result.skipped).toBe(true)
    expect(result.missing).toEqual([])
  })
})
