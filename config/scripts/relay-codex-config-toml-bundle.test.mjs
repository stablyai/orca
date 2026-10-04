import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'smol-toml'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Why: relay hosts run the esbuild bundle with no node_modules, so the Codex config
// parser must be inlined; a runtime-resolved require only fails on a real SSH host.
let root
let applyRelayAgentWorkspaceTrust

beforeAll(async () => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-relay-codex-toml-')))
  const outfile = join(root, 'bundle', 'agent-workspace-trust-spawn.js')
  // Same options as build-relay.mjs uses for relay.js.
  await build({
    entryPoints: [resolve('src/relay/agent-workspace-trust-spawn.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ['node-pty', '@parcel/watcher', 'electron'],
    logLevel: 'silent'
  })
  ;({ applyRelayAgentWorkspaceTrust } = createRequire(outfile)(outfile))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('relay bundle Codex trust write', () => {
  it('loads outside any node_modules and edits a quoted ["projects"."…"] table in place', async () => {
    const codexHome = join(root, 'codex-home')
    const workspace = join(root, 'wt')
    mkdirSync(codexHome)
    mkdirSync(workspace)
    const configPath = join(codexHome, 'config.toml')
    writeFileSync(configPath, `["projects"."${workspace}"]\ntrust_level = "untrusted"\n`)

    await applyRelayAgentWorkspaceTrust(
      { workspacePath: workspace },
      'codex',
      { HOME: root, CODEX_HOME: codexHome },
      { wslShell: false }
    )

    expect(readFileSync(configPath, 'utf-8')).toBe(
      `["projects"."${workspace}"]\ntrust_level = "trusted"\n`
    )
  })

  it('repairs a duplicate an older Orca wrote using only Node 18 array methods', async () => {
    const codexHome = join(root, 'codex-home-node18')
    const workspace = join(root, 'wt-node18')
    mkdirSync(codexHome)
    mkdirSync(workspace)
    const configPath = join(codexHome, 'config.toml')
    writeFileSync(
      configPath,
      `["projects"."${workspace}"]\ntrust_level = "trusted"\n\n[projects."${workspace}"]\ntrust_level = "trusted"\n`
    )
    // Why: SSH hosts may run the relay on Node 18, which lacks the Node 20 copy-array methods.
    const node20Methods = ['toReversed', 'toSorted', 'toSpliced', 'with']
    const saved = node20Methods.map((name) => [name, Array.prototype[name]])
    for (const name of node20Methods) {
      delete Array.prototype[name]
    }
    try {
      await applyRelayAgentWorkspaceTrust(
        { workspacePath: workspace },
        'codex',
        { HOME: root, CODEX_HOME: codexHome },
        { wslShell: false }
      )
    } finally {
      for (const [name, method] of saved) {
        Array.prototype[name] = method
      }
    }

    const repaired = readFileSync(configPath, 'utf-8')
    expect(parse(repaired).projects[workspace].trust_level).toBe('trusted')
    expect(repaired.match(/trust_level/g)).toHaveLength(1)
  })
})
