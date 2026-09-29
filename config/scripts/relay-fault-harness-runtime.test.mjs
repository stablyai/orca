import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ORCAD_BUN_VERSION } from '../../src/shared/orcad-bun-runtime.ts'
import { resolveRelayFaultHarnessRuntime } from './relay-fault-harness-runtime.mjs'

const roots = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function fixture(platform, arch) {
  const root = mkdtempSync(join(tmpdir(), 'relay-fault-runtime-'))
  roots.push(root)
  const directory = join(root, 'out/cli-runtime', `${platform}-${arch}`)
  mkdirSync(directory, { recursive: true })
  copyFileSync(
    new URL('../../resources/licenses/bun/LICENSE.md', import.meta.url),
    join(directory, 'LICENSE.md')
  )
  const bytes = Buffer.from('fixture binary')
  writeFileSync(join(directory, 'bun-runtime'), bytes)
  writeFileSync(
    join(directory, 'runtime.json'),
    JSON.stringify({
      version: ORCAD_BUN_VERSION,
      target: `${platform}-${arch}${platform === 'linux' ? '-glibc' : ''}`,
      sha256: createHash('sha256').update(bytes).digest('hex')
    })
  )
  return { root, directory }
}
it.each([
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
  ['linux', 'x64'],
  ['linux', 'arm64']
])(
  'selects the existing verified %s/%s artifact, never the controller runtime',
  (platform, arch) => {
    const { root, directory } = fixture(platform, arch)
    const runtime = resolveRelayFaultHarnessRuntime(root, platform, arch)
    expect(runtime).toEqual({
      executable: join(directory, 'bun-runtime'),
      args: ['--no-env-file', '--config=/dev/null', '--no-install']
    })
    expect(runtime.executable).not.toBe(process.execPath)
    writeFileSync(join(directory, 'bun-runtime'), 'corrupt')
    expect(() => resolveRelayFaultHarnessRuntime(root, platform, arch)).toThrow(
      'Prepare the bundled CLI runtime'
    )
  }
)
it('rejects absent or wrong-architecture artifacts without a Node fallback', () => {
  const { root } = fixture('darwin', 'arm64')
  for (const [platform, arch] of [
    ['darwin', 'x64'],
    ['win32', 'x64'],
    ['win32', 'arm64']
  ]) {
    expect(() => resolveRelayFaultHarnessRuntime(root, platform, arch)).toThrow(
      'Prepare the bundled CLI runtime'
    )
  }
})
it('uses the selected executable and owned arguments for both daemon and connector', () => {
  const source = readFileSync(new URL('./relay-watcher-fault-harness.mjs', import.meta.url), 'utf8')
  expect(source).not.toContain('spawn(process.execPath')
  expect(source).toContain('spawn(runtime.executable, [...runtime.args, entryPath, ...args]')
  expect(source).toMatch(/daemon = spawn\(\s*runtime.executable,\s*\[\s*\.\.\.runtime.args,/)
  expect(source).toMatch(/createRelayClient\(\s*runtime,\s*relayEntry,/)
})
