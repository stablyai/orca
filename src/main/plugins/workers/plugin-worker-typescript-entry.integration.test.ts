import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { PluginWorkerManager } from './plugin-worker-manager'

let bundleRoot = ''
let pluginRoot = ''
let hostEntryPath = ''
let manager: PluginWorkerManager | null = null

beforeAll(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), 'orca-plugin-host-ts-bundle-'))
  hostEntryPath = join(bundleRoot, 'plugin-host-entry.cjs')
  await build({
    entryPoints: [join(process.cwd(), 'src', 'main', 'plugins', 'workers', 'plugin-host-entry.ts')],
    outfile: hostEntryPath,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: false,
    logLevel: 'silent'
  })
  pluginRoot = await mkdtemp(join(tmpdir(), 'orca-plugin-ts-worker-'))
  await mkdir(join(pluginRoot, 'lib'))
  await writeFile(
    join(pluginRoot, 'main.ts'),
    [
      "import type { OrcaWorkerApi } from 'orca/worker'",
      "import { greet, Tone } from './lib/greet.js'",
      '',
      'export default function activate(orca: OrcaWorkerApi): void {',
      "  orca.commands.register('greet', (args) => greet(String(args), Tone.Loud))",
      "  orca.commands.register('fail', () => {",
      "    throw new Error('worker failed here')",
      '  })',
      '}',
      ''
    ].join('\n')
  )
  // An enum and a parameter property: syntax Node's own type stripping refuses.
  await writeFile(
    join(pluginRoot, 'lib', 'greet.ts'),
    [
      'export enum Tone { Quiet, Loud }',
      'class Greeter { constructor(private readonly name: string) {} hello(): string { return `hi ${this.name}` } }',
      'export function greet(name: string, tone: Tone): string {',
      '  const text = new Greeter(name).hello()',
      '  return tone === Tone.Loud ? text.toUpperCase() : text',
      '}',
      ''
    ].join('\n')
  )
}, 30_000)

afterAll(async () => {
  await manager?.disposeAll()
  await Promise.all(
    [bundleRoot, pluginRoot].map((dir) => dir && rm(dir, { recursive: true, force: true }))
  )
})

// Spawns a real worker process that transpiles on first import.
it('runs a main.ts worker with relative .ts imports and maps stack traces to .ts lines', async () => {
  manager = new PluginWorkerManager({
    entryPath: hostEntryPath,
    executeHostCall: async () => ({ ok: true, value: null }),
    log: () => vi.fn(),
    onWorkerStateChange: vi.fn()
  })
  const worker = await manager.ensureActive({
    pluginKey: 'samples.typescript',
    rootDir: pluginRoot,
    mainEntry: 'main.ts',
    grantedCapabilities: []
  })

  expect([...worker.commands].sort()).toEqual(['fail', 'greet'])
  await expect(worker.invokeCommand('greet', 'ada')).resolves.toBe('HI ADA')
  await expect(worker.invokeCommand('fail')).rejects.toThrow(/main\.ts:7:\d+/)
}, 30_000)
