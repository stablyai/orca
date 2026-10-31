import { runProcess } from '@orca/process-host'
import { cp } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { stageOrcadRichOutput } from './orcad-rich-output-bundle.mjs'
import {
  createClaudeRichOutputBuildFixture,
  cleanupClaudeRichOutputBuildFixtures
} from './claude-rich-output-build-test-fixture.mjs'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original()
  return { ...actual, cp: vi.fn(actual.cp) }
})
const native = await vi.importActual('node:fs/promises')
afterEach(() => {
  vi.mocked(cp).mockReset().mockImplementation(native.cp)
  cleanupClaudeRichOutputBuildFixtures()
})

function startBuilder(root, put) {
  put(
    'builder.mjs',
    `import { writeFileSync } from 'node:fs';
writeFileSync('writer-ready', '');
await import('./config/scripts/build-claude-rich-output.mjs');`
  )
  return runProcess({
    program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
    args: [join(root, 'builder.mjs')],
    cwd: root,
    timeoutMs: 25_000
  })
}

const settledCopy = (root, destination) =>
  stageOrcadRichOutput(root, destination).then(
    () => ({ state: 'copied' }),
    (error) => ({ state: 'error', message: String(error) })
  )
const blocked = () => new Promise((resolve) => setTimeout(() => resolve('blocked'), 1000))
const waitFor = (file) => expect.poll(() => existsSync(file), { timeout: 10_000 }).toBe(true)

test('ORCAD waits for an in-progress resource build before reading its manifest and files', async () => {
  const { root, put, build } = createClaudeRichOutputBuildFixture()
  build()
  put('resources/claude-rich-output/foo', 'updated')
  put(
    'node_modules/esbuild/index.js',
    `import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
export async function build() {
  writeFileSync('bundle-entered', '');
  const deadline = Date.now() + 15000;
  while (!existsSync('release')) {
    if (Date.now() > deadline) throw new Error('bundle gate timed out');
    await setTimeout(10);
  }
}`
  )
  const writer = startBuilder(root, put)
  let copying
  try {
    await waitFor(join(root, 'bundle-entered'))
    copying = settledCopy(root, join(root, 'staged'))
    expect(await Promise.race([copying.then(() => 'finished'), blocked()])).toBe('blocked')
  } finally {
    put('release', '')
    const [result, copied] = await Promise.all([writer, copying])
    expect(result.code, result.stderr).toBe(0)
    if (copying) {
      expect(copied).toEqual({ state: 'copied' })
    }
  }
  expect(readFileSync(join(root, 'staged/claude-rich-output/foo'), 'utf8')).toBe('updated')
  expect(
    JSON.parse(readFileSync(join(root, 'staged/claude-rich-output/manifest.json'), 'utf8')).assets
  ).toContain('claude-rich-output/foo')
})

test('a resource build waits until ORCAD has finished copying its previous snapshot', async () => {
  const { root, put, build } = createClaudeRichOutputBuildFixture()
  build()
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  vi.mocked(cp).mockImplementationOnce((source, destination, options) =>
    native.cp(source, destination, {
      ...options,
      filter: async () => {
        entered.resolve()
        await release.promise
        return true
      }
    })
  )
  const copying = settledCopy(root, join(root, 'staged'))
  let writer
  try {
    await entered.promise
    put('resources/claude-rich-output/foo', 'updated')
    writer = startBuilder(root, put)
    await waitFor(join(root, 'writer-ready'))
    expect(await Promise.race([writer.then(() => 'finished'), blocked()])).toBe('blocked')
  } finally {
    release.resolve()
    const [copied, result] = await Promise.all([copying, writer])
    expect(copied).toEqual({ state: 'copied' })
    if (result) {
      expect(result.code, result.stderr).toBe(0)
    }
  }
  expect(readFileSync(join(root, 'staged/claude-rich-output/foo'), 'utf8')).toBe('barvalue')
  expect(readFileSync(join(root, 'out/claude-rich-output/foo'), 'utf8')).toBe('updated')
})

test('a real staging filesystem failure releases ownership for a subsequent copy', async () => {
  const { root, put, build } = createClaudeRichOutputBuildFixture()
  build()
  put('occupied', 'not a directory')
  await expect(stageOrcadRichOutput(root, join(root, 'occupied'))).rejects.toThrow()
  expect(existsSync(join(root, 'out/.claude-rich-output-build.lock'))).toBe(false)
  await stageOrcadRichOutput(root, join(root, 'staged'))
  expect(readFileSync(join(root, 'staged/claude-rich-output/foo'), 'utf8')).toBe('barvalue')
  expect(existsSync(join(root, 'out/.claude-rich-output-build.lock'))).toBe(false)
})

test.each(['fulfilled', 'rejected'])(
  'a release callback failure preserves the %s build outcome',
  async (outcome) => {
    const { default: lockfile } = await import('proper-lockfile')
    const { withClaudeRichOutputBuildLock } = await import('./claude-rich-output-build-lock.mjs')
    const { root } = createClaudeRichOutputBuildFixture()
    const originalLock = lockfile.lock.bind(lockfile)
    const failure = new Error('resource build failed')
    const releaseFailure = new Error('release callback failed after native unlock')
    const result = { manifest: 'written' }
    let released = 0
    const spy = vi.spyOn(lockfile, 'lock').mockImplementationOnce(async (...args) => {
      const release = await originalLock(...args)
      return async () => {
        await release()
        released++
        throw releaseFailure
      }
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const building = withClaudeRichOutputBuildLock(root, async (assertLockHeld) => {
        assertLockHeld()
        if (outcome === 'rejected') {
          throw failure
        }
        return result
      })
      await (outcome === 'rejected'
        ? expect(building).rejects.toBe(failure)
        : expect(building).resolves.toBe(result))
      expect(released).toBe(1)
      expect(existsSync(join(root, 'out/.claude-rich-output-build.lock'))).toBe(false)
      expect(warning).toHaveBeenCalledWith(expect.any(String), releaseFailure)
    } finally {
      spy.mockRestore()
      warning.mockRestore()
    }
  }
)
