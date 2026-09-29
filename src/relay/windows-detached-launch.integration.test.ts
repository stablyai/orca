import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { runProcess } from '../shared/child-process/run-process'

const runtime = process.env.BUN_EXECUTABLE
async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 8_000
  while (performance.now() < deadline) {
    if (await check()) {
      return
    }
    await delay(50)
  }
  throw new Error('Detached launch evidence did not arrive before its deadline')
}
async function contents(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return ''
    }
    throw error
  }
}
it.skipIf(process.platform !== 'win32')(
  'restricts handles, preserves argv and logs, and survives its owned SSH-style job',
  async () => {
    if (!runtime) {
      throw new Error('BUN_EXECUTABLE is required')
    }
    const directory = await mkdtemp(join(tmpdir(), 'orca-detached-launch-'))
    const entry = join(directory, 'launch-fixture.cjs')
    const args = [
      '',
      'space value',
      'tab\tvalue',
      'quote"value',
      'trailing\\',
      'space trailing\\',
      '\\"',
      '雪 🐳 λ',
      '& | < > %PATH% !name! ^',
      'line\nbreak'
    ]
    const execute = (fixtureArgs: string[]) =>
      runProcess({
        program: runtime,
        args: [entry, ...fixtureArgs],
        cwd: directory,
        env: { ORCA_BACKGROUND_LAUNCH: '1', BUN_OPTIONS: '', NODE_OPTIONS: '', NODE_PATH: '' },
        timeoutMs: 20_000
      })
    let launched = false
    let cleaned = false
    try {
      await build({
        entryPoints: [join(__dirname, 'windows-detached-launch-fixture.ts')],
        outfile: entry,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'es2024',
        external: ['bun:ffi']
      })
      await writeFile(join(directory, 'stdout.log'), 'existing stdout\n')
      await writeFile(join(directory, 'stderr.log'), 'existing stderr\n')
      launched = true
      const result = await execute([
        'launch',
        directory,
        `Local\\orca-launch-${randomUUID()}`,
        '-',
        ...args
      ])
      expect(result.timedOut, result.stderr).toBe(false)
      // Closing a kill-on-close job can alter the launcher's exit status; its durable receipt is authoritative.
      const launch = JSON.parse(await readFile(join(directory, 'launch.json'), 'utf8'))
      const child = JSON.parse(await readFile(join(directory, 'child.json'), 'utf8'))
      expect(launch).toEqual({ pid: child.pid, parentInJob: true })
      expect(child).toMatchObject({ args, childInJob: false, markerInherited: false })
      const owned = JSON.parse(await readFile(join(directory, 'owned-child.json'), 'utf8'))
      expect(owned).toEqual({ pid: child.pid, creation: child.creation })
      expect(child.creation).toMatch(/^\d+$/)
      const first = Number(await contents(join(directory, 'tick')))
      await waitFor(async () => Number(await contents(join(directory, 'tick'))) > first + 2)
      await waitFor(
        async () =>
          (await contents(join(directory, 'stdout.log'))).includes('child stdout: 雪 🐳\n') &&
          (await contents(join(directory, 'stderr.log'))).includes('child stderr: λ\n')
      )
      expect(await contents(join(directory, 'stdout.log'))).toBe(
        'existing stdout\nchild stdout: 雪 🐳\n'
      )
      expect(await contents(join(directory, 'stderr.log'))).toBe(
        'existing stderr\nchild stderr: λ\n'
      )
      await rename(join(directory, 'stdout.log'), join(directory, 'stdout.old'))
      await rename(join(directory, 'stderr.log'), join(directory, 'stderr.old'))
      await writeFile(join(directory, 'stdout.log'), 'replacement stdout\n')
      await writeFile(join(directory, 'stderr.log'), 'replacement stderr\n')
      await writeFile(join(directory, 'rotated'), '')
      await waitFor(
        async () =>
          (await contents(join(directory, 'stdout.old'))).endsWith('after rotation stdout\n') &&
          (await contents(join(directory, 'stderr.old'))).endsWith('after rotation stderr\n')
      )
      expect(await contents(join(directory, 'stdout.log'))).toBe('replacement stdout\n')
      expect(await contents(join(directory, 'stderr.log'))).toBe('replacement stderr\n')
    } finally {
      if (launched) {
        // Cleanup opens a creation-time-matched handle before asking the child to exit.
        if (await contents(join(directory, 'owned-child.json'))) {
          const cleanup = await execute(['inspect', directory])
          expect(cleanup.timedOut, `${cleanup.stderr}; evidence: ${directory}`).toBe(false)
          expect(cleanup.code, `${cleanup.stderr}; evidence: ${directory}`).toBe(0)
          cleaned = true
        } else {
          await writeFile(join(directory, 'stop'), '')
          expect.fail(`Cleanup unverifiable without owned child identity; evidence: ${directory}`)
        }
      }
      if (!launched || cleaned) {
        await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    }
  },
  60_000
)
