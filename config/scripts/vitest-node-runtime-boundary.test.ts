import { globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { runProcess } from '@orca/process-host'
import ts from 'typescript-api'
import { expect, it, onTestFinished } from 'vitest'
import { discoverUnitFiles } from './ci-unit-files.mjs'
import { getNodeRuntimeInclude } from './vitest-node-runtime-files.mjs'
import { importsSqliteRuntime } from './vitest-sqlite-runtime-scan.mjs'

it('runs Node runtime contracts in Node even when the coordinator uses Bun', () => {
  expect(process.versions.bun).toBeUndefined()
  expect(process.release.name).toBe('node')
  expect(Number(process.versions.node.split('.')[0])).toBeGreaterThanOrEqual(24)
})

function isGlobalThis(expression: ts.Expression): boolean {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return isGlobalThis(expression.expression)
  }
  return ts.isIdentifier(expression) && expression.text === 'globalThis'
}

it('keeps exposed-GC heap measurements in the Node runtime project', () => {
  const root = process.cwd()
  const nodeFiles = new Set(globSync(getNodeRuntimeInclude()).map((file) => resolve(root, file)))
  const missing: string[] = []
  for (const file of discoverUnitFiles(root)) {
    if (nodeFiles.has(resolve(root, file))) {
      continue
    }
    const source = readFileSync(resolve(root, file), 'utf8')
    if (!source.includes('heapUsed') || !source.includes('gc')) {
      continue
    }
    const module = ts.createSourceFile(file, source, ts.ScriptTarget.Latest)
    let usesGlobalGc = false
    const visit = (node: ts.Node): void => {
      if (
        (ts.isPropertyAccessExpression(node) &&
          node.name.text === 'gc' &&
          isGlobalThis(node.expression)) ||
        (ts.isElementAccessExpression(node) &&
          ts.isStringLiteral(node.argumentExpression) &&
          node.argumentExpression.text === 'gc' &&
          isGlobalThis(node.expression))
      ) {
        usesGlobalGc = true
      }
      ts.forEachChild(node, visit)
    }
    visit(module)
    if (usesGlobalGc) {
      missing.push(file)
    }
  }
  expect(missing).toEqual([])
})

it.each([
  {
    fixture: 'historical release checkout and source fixture',
    file: 'tests/e2e/cross-version-wire/qoder-history-search-downgrade.unit.test.ts',
    pattern:
      /[/\\]tests[/\\]e2e[/\\]cross-version-wire[/\\]qoder-history-search-downgrade\.unit\.test\.ts$/
  },
  {
    fixture: 'indirect native PTY shell fixture',
    file: 'src/main/daemon/repro-13767-shell-ready-marker-lost-to-exec.test.ts',
    pattern:
      /[/\\]src[/\\]main[/\\]daemon[/\\]repro-13767-shell-ready-marker-lost-to-exec\.test\.ts$/
  },
  {
    fixture: 'CLI process-group termination fixture',
    file: 'src/main/ipc/preflight-runnable-local-cli.test.ts',
    pattern: /[/\\]src[/\\]main[/\\]ipc[/\\]preflight-runnable-local-cli\.test\.ts$/
  },
  {
    fixture: 'Hermes filesystem preservation fixture',
    file: 'src/main/hermes/hermes-config-preservation.test.ts',
    pattern: /[/\\]src[/\\]main[/\\]hermes[/\\]hermes-config-preservation\.test\.ts$/
  },
  {
    fixture: 'native session-search ownership fixture',
    file: 'src/main/ai-vault-search/session-search-current-owner.test.ts',
    pattern: /[/\\]src[/\\]main[/\\]ai-vault-search[/\\]session-search-current-owner\.test\.ts$/
  },
  {
    fixture: 'native session-search device dispatch fixture',
    file: 'src/main/runtime/runtime-rpc-device-key-dispatch.test.ts',
    pattern: /[/\\]src[/\\]main[/\\]runtime[/\\]runtime-rpc-device-key-dispatch\.test\.ts$/
  },
  {
    fixture: 'native session-search relay fixture',
    file: 'src/main/runtime/mobile-cloud-relay/mobile-relay-e2ee.integration.test.ts',
    pattern:
      /[/\\]src[/\\]main[/\\]runtime[/\\]mobile-cloud-relay[/\\]mobile-relay-e2ee\.integration\.test\.ts$/
  },
  {
    fixture: 'renderer sender census filesystem fixture',
    file: 'src/renderer/src/runtime/layout-apply-paired-server-guard.test.ts',
    pattern:
      /[/\\]src[/\\]renderer[/\\]src[/\\]runtime[/\\]layout-apply-paired-server-guard\.test\.ts$/
  }
])('collects $fixture exactly once in the Node project', async ({ file, pattern }) => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-runtime-list-'))
  const output = join(directory, 'files.json')
  const collecting = runProcess({
    program: process.execPath,
    args: [
      'config/scripts/run-vitest.mjs',
      'list',
      '--config',
      'config/vitest.config.ts',
      file,
      '--filesOnly',
      `--json=${output}`
    ],
    cwd: process.cwd(),
    env: { ...process.env, ORCA_BALANCE_UNIT_SHARDS: '0' },
    timeoutMs: 20_000,
    detached: true,
    terminationBarrier: true
  })
  // Join the barrier even when its final verification outlives the test body.
  onTestFinished(async () => {
    try {
      await collecting
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  const result = await collecting
  expect(result.code, result.stderr).toBe(0)
  const collected: unknown = JSON.parse(readFileSync(output, 'utf8'))
  expect(collected).toEqual([
    expect.objectContaining({
      file: expect.stringMatching(pattern),
      projectName: 'node-runtime'
    })
  ])
})

it.each([
  'src/main/ai-vault-search/session-search-index-pass.test.ts',
  'src/main/ai-vault-search/session-search-engine.test.ts',
  'src/main/persistence/profile-state/profile-state-store-factory.test.ts'
])('keeps upstream and local SQLite consumers on Node: %s', (file) => {
  expect(importsSqliteRuntime(file, readFileSync(file, 'utf8'))).toBe(true)
})
