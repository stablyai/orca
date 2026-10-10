import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { ORCAD_LAUNCHER_FILENAME, ORCAD_SERVER_ENTRY_FILENAME } from '../../shared/orcad-artifacts'
import { NODE_RUNTIME_PIN } from '../../shared/node-runtime-pin'
import { hashOrcadLauncher } from '../../shared/orcad-build-identity'
import {
  locatePinnedNodeForTests,
  skipForMissingInputs,
  writeNodeSlotFixture
} from './orcad-node-slot-fixture'

const pinnedNode = locatePinnedNodeForTests()
const launcherNode =
  process.env.ORCA_TEST_LAUNCHER_NODE_EXECUTABLE ??
  process.env.ORCA_TEST_NODE_EXECUTABLE ??
  process.execPath
let root = ''
let launcher = ''
let inputs: string[] = []
const SERVER_FIXTURE = [
  'using resource = { [Symbol.dispose]() {} };',
  'console.log(JSON.stringify({ node: process.versions.node, args: process.argv.slice(2) }));'
].join('\n')

async function buildLauncher(entry: string): Promise<string[]> {
  const builder = pathToFileURL(join(process.cwd(), 'config/scripts/orcad-entry-build.mjs')).href
  const result = await runProcess({
    program: process.execPath,
    args: [
      '--input-type=module',
      '-e',
      `import {buildOrcadLauncher} from ${JSON.stringify(builder)};` +
        `const result=await buildOrcadLauncher(${JSON.stringify(entry)});` +
        'console.log(JSON.stringify(Object.keys(result.metafile.inputs)))'
    ],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  })
  expect(result.code, result.stderr).toBe(0)
  return JSON.parse(result.stdout)
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-launcher-isolation-'))
  launcher = join(root, ORCAD_LAUNCHER_FILENAME)
  await writeFile(join(root, ORCAD_SERVER_ENTRY_FILENAME), SERVER_FIXTURE)
  inputs = await buildLauncher(launcher)
})

it('changes the launcher identity when the server is rebuilt', async () => {
  const directory = join(root, 'rebuilt')
  await mkdir(directory)
  const entry = join(directory, ORCAD_LAUNCHER_FILENAME)
  const server = join(directory, ORCAD_SERVER_ENTRY_FILENAME)
  await writeFile(server, SERVER_FIXTURE)
  await buildLauncher(entry)
  const first = hashOrcadLauncher(entry)
  await writeFile(server, 'console.log("rebuilt server")')
  await buildLauncher(entry)
  expect(hashOrcadLauncher(entry)).not.toBe(first)
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('keeps the server and profile-state graph outside the compatibility launcher', async () => {
  expect(inputs.filter((path) => path.startsWith('src/main/'))).toEqual([
    'src/main/orcad/orcad-app-paths.ts',
    'src/main/orcad/orcad-bundled-runtime.ts',
    'src/main/orcad/launcher.ts'
  ])
  expect(inputs.some((path) => path.startsWith('node_modules/'))).toBe(false)
  expect((await readFile(launcher)).length).toBeLessThan(32 * 1024)
})

it('runs an unpackaged server on the supported host runtime and preserves arguments', async () => {
  const directory = join(root, 'unpackaged')
  await mkdir(directory)
  const entry = join(directory, ORCAD_LAUNCHER_FILENAME)
  await writeFile(
    join(directory, ORCAD_SERVER_ENTRY_FILENAME),
    'console.log(JSON.stringify({ node: process.versions.node, args: process.argv.slice(2) }))'
  )
  await buildLauncher(entry)
  const version = await runProcess({ program: launcherNode, args: ['-p', 'process.versions.node'] })
  const args = ['a path with spaces', '--port', '0']
  const result = await runProcess({
    program: launcherNode,
    args: [entry, ...args],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  })
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ node: version.stdout.trim(), args })
})

it('preserves the crash exit code when the server fails while loading', async () => {
  const directory = join(root, 'server-crash')
  await mkdir(directory)
  const entry = join(directory, ORCAD_LAUNCHER_FILENAME)
  await writeFile(
    join(directory, ORCAD_SERVER_ENTRY_FILENAME),
    'throw new Error("server evaluation failed")'
  )
  await buildLauncher(entry)
  const result = await runProcess({
    program: process.execPath,
    args: [entry],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('server evaluation failed')
  expect(result.stderr).not.toContain('orcad: failed to launch:')
})

const skip = skipForMissingInputs('artifact', pinnedNode ? [] : ['the pinned Node runtime'])

describe.skipIf(skip)('split launcher with the real bundled runtime', () => {
  it('hands off before parsing Node 24 server syntax and preserves arguments', async () => {
    if (!pinnedNode) {
      throw new Error('Missing pinned runtime')
    }
    const { slotDir } = await writeNodeSlotFixture(join(root, 'handoff'), pinnedNode)
    await writeFile(join(slotDir, ORCAD_LAUNCHER_FILENAME), await readFile(launcher))
    const server = join(slotDir, ORCAD_SERVER_ENTRY_FILENAME)
    await writeFile(server, SERVER_FIXTURE)
    const args = ['a path with spaces', 'line one\nline two', '--port', '0']
    const result = await runProcess({
      program: launcherNode,
      args: [join(slotDir, ORCAD_LAUNCHER_FILENAME), ...args],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
    })
    expect(result.code, result.stderr.slice(0, 2000)).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ node: NODE_RUNTIME_PIN.version, args })
  })

  it('refuses changed server bytes before loading them', async () => {
    if (!pinnedNode) {
      throw new Error('Missing pinned runtime')
    }
    const { slotDir, runtime } = await writeNodeSlotFixture(join(root, 'tampered'), pinnedNode)
    await writeFile(join(slotDir, ORCAD_LAUNCHER_FILENAME), await readFile(launcher))
    await writeFile(
      join(slotDir, ORCAD_SERVER_ENTRY_FILENAME),
      'throw new Error("server was loaded")'
    )
    const result = await runProcess({
      program: runtime,
      args: [join(slotDir, ORCAD_LAUNCHER_FILENAME)],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
    })
    expect(result.code).toBe(78)
    expect(result.stderr).toContain('server does not match its launcher')
    expect(result.stderr).not.toContain('server was loaded')
  })

  it('refuses an old host runtime without a bundle before loading the server', async ({ skip }) => {
    const version = await runProcess({
      program: launcherNode,
      args: ['-p', 'process.versions.node']
    })
    if (Number(version.stdout.trim().split('.')[0]) >= 18) {
      skip()
    }
    await writeFile(join(root, ORCAD_SERVER_ENTRY_FILENAME), 'throw new Error("server was loaded")')
    const result = await runProcess({
      program: launcherNode,
      args: [launcher],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
    })
    expect(result.code).toBe(78)
    expect(result.stderr).toContain('requires Node.js 18')
    expect(result.stderr).not.toContain('server was loaded')
  })
})
