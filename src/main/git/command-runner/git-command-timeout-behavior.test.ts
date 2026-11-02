import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitExecFileAsync, gitExecFileAsyncBuffer } from './git-exec-file'
import { GitCommandTimeoutError } from './git-command-timeout'
import { gitStreamStdout } from './git-stream-stdout'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createTimedGitFixture(): Promise<{
  cwd: string
  env: NodeJS.ProcessEnv
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-git-timeout-'))
  tempRoots.push(root)
  const binDir = path.join(root, 'bin')
  const cwd = path.join(root, 'repo')
  await mkdir(binDir)
  await mkdir(cwd)
  const script = path.join(binDir, 'git')
  await writeFile(
    script,
    `#!/usr/bin/env node
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function run() {
  if (process.env.ORCA_STUB_PROGRESSIVE === '1') {
    const remaining = Math.max(0, Number(process.env.ORCA_STUB_EXIT_AT_MS) - Date.now())
    const step = remaining / 3
    await sleep(step)
    process.stdout.write('one')
    await sleep(step)
    process.stdout.write('two')
    await sleep(step)
    process.stdout.write('three')
    return
  }
  await sleep(Number(process.env.ORCA_STUB_SLEEP_MS))
  process.stdout.write('done')
}
void run()
`
  )
  await chmod(script, 0o755)
  return {
    cwd,
    env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` }
  }
}

describe.skipIf(process.platform === 'win32')('git read timeout behavior', () => {
  it('allows a progressively streaming read that exits at 0.9 times the deadline', async () => {
    const fixture = await createTimedGitFixture()
    let output = ''
    await expect(
      gitStreamStdout(['status', '--porcelain=v2'], {
        ...fixture,
        env: {
          ...fixture.env,
          ORCA_STUB_PROGRESSIVE: '1',
          ORCA_STUB_EXIT_AT_MS: String(Date.now() + 900)
        },
        timeoutMsForTest: 1000,
        onStdout: (chunk) => {
          output += chunk
        }
      })
    ).resolves.toEqual({ stoppedEarly: false })
    expect(output).toBe('onetwothree')
  })

  it('rejects a silent read at 1.1 times the deadline with a typed error', async () => {
    const fixture = await createTimedGitFixture()
    await expect(
      gitExecFileAsync(['status', '--porcelain=v2'], {
        ...fixture,
        env: { ...fixture.env, ORCA_STUB_SLEEP_MS: '110' },
        timeoutMsForTest: 100
      })
    ).rejects.toBeInstanceOf(GitCommandTimeoutError)
  })

  it('times out a silent streaming read with the same typed error', async () => {
    const fixture = await createTimedGitFixture()
    await expect(
      gitStreamStdout(['status'], {
        ...fixture,
        env: { ...fixture.env, ORCA_STUB_SLEEP_MS: '110' },
        timeoutMsForTest: 100,
        onStdout: () => {}
      })
    ).rejects.toBeInstanceOf(GitCommandTimeoutError)
  })

  it('applies the read default to binary blob reads', async () => {
    const fixture = await createTimedGitFixture()
    await expect(
      gitExecFileAsyncBuffer(['show', 'HEAD:file.bin'], {
        ...fixture,
        env: { ...fixture.env, ORCA_STUB_SLEEP_MS: '110' },
        timeoutMsForTest: 100
      })
    ).rejects.toBeInstanceOf(GitCommandTimeoutError)
  })

  it.each([['fetch'], ['checkout'], ['unrecognized-command']])(
    'does not default-timeout the fail-safe %s class',
    async (subcommand) => {
      const fixture = await createTimedGitFixture()
      await expect(
        gitExecFileAsync([subcommand], {
          ...fixture,
          env: { ...fixture.env, ORCA_STUB_SLEEP_MS: '110' },
          timeoutMsForTest: 100
        })
      ).resolves.toMatchObject({ stdout: 'done' })
    }
  )
})

describe.skipIf(process.platform === 'win32' || process.env.ORCA_RUN_SLOW_GIT_SMOKE !== '1')(
  'slow git read timeout smoke',
  () => {
    it('allows a 90 second read and terminates a 130 second wedge', async () => {
      const fixture = await createTimedGitFixture()
      await expect(
        gitExecFileAsync(['status'], {
          ...fixture,
          env: { ...fixture.env, ORCA_STUB_SLEEP_MS: '90000' }
        })
      ).resolves.toMatchObject({ stdout: 'done' })
      await expect(
        gitExecFileAsync(['status'], {
          ...fixture,
          env: { ...fixture.env, ORCA_STUB_SLEEP_MS: '130000' }
        })
      ).rejects.toBeInstanceOf(GitCommandTimeoutError)
    }, 230_000)
  }
)
