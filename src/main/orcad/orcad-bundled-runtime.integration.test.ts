import { build } from 'esbuild'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess, spawnProcess } from '../../shared/child-process/run-process'
import { shellEscape } from '../ssh/ssh-connection-utils'

let directory = ''
const children = new Set<ReturnType<typeof spawnProcess>>()

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-handoff-'))
  await build({
    stdin: {
      contents: `
        import { handoffToBundledOrcad } from './src/main/orcad/orcad-bundled-runtime'
        if (process.env.ORCA_TEST_HANDOFF_CHILD === '1') {
          for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
            process.on(signal, () => { console.log('received:' + signal); process.exit(29) })
          }
          console.log('ready:' + JSON.stringify(process.argv.slice(2)))
          setTimeout(() => process.exit(99), 4_000)
        } else if (!handoffToBundledOrcad()) {
          throw new Error('handoff failed')
        }
      `,
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    outfile: join(directory, 'orcad.js'),
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs'
  })
  await writeFile(join(directory, '.build-target'), 'darwin-arm64\n')
  const runtime = join(directory, 'bun-runtime')
  await writeFile(
    runtime,
    `#!/bin/sh\nORCA_TEST_HANDOFF_CHILD=1 exec ${shellEscape(process.execPath)} "$@"\n`
  )
  await chmod(runtime, 0o700)
})

afterEach(async () => {
  for (const child of children) {
    child.kill('SIGKILL')
  }
  children.clear()
  await rm(directory, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('bundled handoff process lifecycle', () => {
  it('refuses a partial installation before launching its adjacent runtime', async () => {
    await rm(join(directory, '.build-target'))
    const result = await runProcess({
      program: process.execPath,
      args: [join(directory, 'orcad.js')],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 5_000
    })
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('bundled Orca runtime target is missing')
    expect(result.stdout).not.toContain('ready:')
  })

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
    'forwards %s to the actual child and mirrors its exit',
    async (signal) => {
      const args = ['--label', 'two words', 'quote"$literal']
      const child = spawnProcess({
        program: process.execPath,
        args: [join(directory, 'orcad.js'), ...args],
        env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      children.add(child)
      let output = ''
      child.stdout.on('data', (data: Buffer) => {
        output += data.toString()
      })
      child.stderr.on('data', (data: Buffer) => {
        output += data.toString()
      })
      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once('error', reject)
          child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }))
        }
      )
      await vi.waitFor(() => expect(output).toContain(`ready:${JSON.stringify(args)}`), {
        timeout: 2_000
      })
      child.kill(signal)
      expect(await exit).toEqual({ code: 29, signal: null })
      children.delete(child)
      expect(output).toContain(`received:${signal}`)
    }
  )
})
