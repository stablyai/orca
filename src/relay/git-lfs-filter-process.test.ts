import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitExecFileAsyncBuffer } from '../main/git/command-runner/git-exec-file'
import { runProcess } from '../shared/child-process/run-process'
import { runGitToTermination } from './git-handler-command-termination'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

async function filterArguments(source: string): Promise<string[]> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-lfs-filter-'))
  temporaryRoots.push(root)
  const attributes = path.join(root, 'attributes')
  await writeFile(attributes, 'AGENTS.md filter=orcapreview\n')
  return [
    '-c',
    `core.attributesFile=${attributes}`,
    '-c',
    `filter.orcapreview.smudge=${shellQuote(process.execPath)} -e ${shellQuote(source)}`,
    'cat-file',
    '--filters',
    '--',
    'HEAD:AGENTS.md'
  ]
}

describe.skipIf(process.platform === 'win32')('owned Git image filter processes', () => {
  it.each(['desktop', 'relay'] as const)(
    'preserves binary filter output in %s',
    async (runtime) => {
      const args = await filterArguments(
        'process.stdin.resume(); process.stdin.on("end",()=>process.stdout.write(Buffer.from([0,255,137,195,128])))'
      )
      const content =
        runtime === 'desktop'
          ? (await gitExecFileAsyncBuffer(args, { cwd: process.cwd() })).stdout
          : (
              await runGitToTermination(
                args,
                { cwd: process.cwd(), env: process.env, captureStdoutAsBytes: true },
                undefined
              )
            ).stdoutBytes
      expect(content).toEqual(Buffer.from([0, 255, 137, 195, 128]))
    }
  )

  it.each(['desktop', 'relay'] as const)(
    'terminates a filter ignoring SIGTERM on %s timeout',
    async (runtime) => {
      const root = await mkdtemp(path.join(tmpdir(), 'orca-lfs-filter-pid-'))
      temporaryRoots.push(root)
      const marker = path.join(root, 'pid')
      const args = await filterArguments(
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid)); process.on('SIGTERM',()=>{}); process.stdin.resume(); setTimeout(()=>process.exit(0),5000)`
      )
      const pending =
        runtime === 'desktop'
          ? gitExecFileAsyncBuffer(args, { cwd: process.cwd(), timeoutMsForTest: 1000 })
          : runGitToTermination(
              args,
              { cwd: process.cwd(), env: process.env, captureStdoutAsBytes: true, timeout: 1000 },
              undefined
            )
      await expect(pending).rejects.toThrow(/timed out/)
      const pid = (await readFile(marker, 'utf8')).trim()
      const probe = await runProcess({
        program: 'ps',
        args: ['-p', pid, '-o', 'state='],
        timeoutMs: 1000
      })
      expect(probe.stdout.trim() === '' || probe.stdout.trim().startsWith('Z')).toBe(true)
    },
    15_000
  )
})
