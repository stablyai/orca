import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {
  collectElectronImporters,
  collectStructuredChatEntryPoints,
  main
} from './check-runtime-electron-ratchet.mjs'

describe('structured chat coverage', () => {
  const roots = []
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function fixture(files) {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-electron-ratchet-'))
    roots.push(root)
    for (const [file, source] of Object.entries(files)) {
      const absolute = path.join(root, file)
      mkdirSync(path.dirname(absolute), { recursive: true })
      writeFileSync(absolute, source)
    }
    return root
  }

  const requiredLanes = {
    'src/main/native-chat/reader.ts': 'export {}',
    'src/main/claude/claude-session.ts': 'export {}',
    'src/main/codex/codex-session.ts': 'export {}',
    'src/main/runtime/structured-agent-session-host.ts': 'export {}',
    'src/main/provider-process/provider-process-teardown.ts': 'export {}',
    'src/main/acp/acp-structured-session-adapter.ts': 'export {}',
    'src/main/jsonl-rpc/peer.ts': 'export {}',
    'src/main/pi/rpc-launch.ts': 'export {}',
    'src/shared/agent-session-record.ts': 'export {}',
    'src/packages/process-host/src/run-process.ts': 'export {}'
  }

  it.each([true, false])(
    'finds Electron through an unwired lane package (sideEffects=%s)',
    async (sideEffects) => {
      const root = fixture({
        ...requiredLanes,
        'src/main/acp/adapter.ts': "import 'acp-desktop-package'",
        'src/main/provider-process/worker.ts': "import 'provider-desktop-package'",
        'src/main/jsonl-rpc/peer.ts': "import 'rpc-desktop-package'",
        'src/main/pi/rpc-launch.ts': "import 'pi-desktop-package'",
        'node_modules/acp-desktop-package/package.json': JSON.stringify({
          main: 'index.js',
          sideEffects
        }),
        'node_modules/acp-desktop-package/index.js': "require('electron')",
        'node_modules/provider-desktop-package/package.json': JSON.stringify({
          main: 'index.js',
          sideEffects
        }),
        'node_modules/provider-desktop-package/index.js': "require('electron')",
        'node_modules/rpc-desktop-package/package.json': JSON.stringify({
          main: 'index.js',
          sideEffects
        }),
        'node_modules/rpc-desktop-package/index.js': "require('electron')",
        'node_modules/pi-desktop-package/package.json': JSON.stringify({
          main: 'index.js',
          sideEffects
        }),
        'node_modules/pi-desktop-package/index.js': "require('electron')"
      })
      const current = await collectElectronImporters(collectStructuredChatEntryPoints(root))
      expect(current.map((file) => file.split('/node_modules/').pop())).toEqual([
        'acp-desktop-package/index.js',
        'pi-desktop-package/index.js',
        'provider-desktop-package/index.js',
        'rpc-desktop-package/index.js'
      ])
    }
  )

  it('checks public workspace imports against source without requiring a built package', async () => {
    const root = fixture({ 'entry.ts': "import '@orca/process-host'" })
    const target = path.join(process.cwd(), 'src/packages/process-host/src/run-process.ts')
    const current = await collectElectronImporters([path.join(root, 'entry.ts')], {
      plugins: [
        {
          name: 'inject-process-host-electron-import',
          setup(pluginBuild) {
            pluginBuild.onLoad({ filter: /run-process\.ts$/ }, (args) =>
              args.path === target ? { contents: "import 'electron'", loader: 'ts' } : undefined
            )
          }
        }
      ]
    })
    expect(current).toEqual(['src/packages/process-host/src/run-process.ts'])
  })
})

// Why `main`: it is what `pnpm lint` and CI run, so these fail if its entry list drops the lanes.
describe('the command-line check', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Why a file the runtime doesn't load: only the structured-chat lanes can catch it.
  it('fails on Electron in structured-chat code the runtime graph does not reach', async () => {
    const target = path.join(
      process.cwd(),
      'src',
      'main',
      'native-chat',
      'transcript-read-cache.ts'
    )
    const addElectron = {
      name: 'add-electron-import',
      setup(pluginBuild) {
        pluginBuild.onLoad({ filter: /transcript-read-cache\.ts$/ }, (args) =>
          args.path === target
            ? { contents: `import 'electron'\n${readFileSync(target, 'utf8')}`, loader: 'ts' }
            : undefined
        )
      }
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await main({ plugins: [addElectron] })).toBe(1)
    expect(error.mock.calls.join('\n')).toContain('+ src/main/native-chat/transcript-read-cache.ts')
  }, 120_000)
})
