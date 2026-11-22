import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { agentSessionFolder, childEnv } from './bot-automation-eval-host'

describe('the benchmarked bot environment', () => {
  it('never points at the owner Orca, its panes, or its own CLI', () => {
    const env = childEnv('/scratch/stand-in', '/scratch/home')

    expect(env.ORCA_USER_DATA_PATH).toBe(join('/scratch/home-eval', 'no-orca'))
    expect(env.ORCA_CLI_COMMAND).toBe(join('/scratch/stand-in', 'bin', 'orca'))
    expect(env.ZDOTDIR).toBe(join('/scratch/stand-in', 'zdot'))
    expect(env.PATH?.startsWith(join('/scratch/stand-in', 'bin'))).toBe(true)
    const realOrca = [
      join(homedir(), 'Library', 'Application Support', 'orca'),
      join(homedir(), '.config', 'orca'),
      join(homedir(), '.orca')
    ]
    for (const [key, value] of Object.entries(env)) {
      if (key.startsWith('ORCA_')) {
        expect(
          realOrca.some((path) => value.startsWith(path)),
          key
        ).toBe(false)
      }
    }
    // Only what the harness sets; an inherited pane or hook variable reaches the live app.
    expect(
      Object.keys(env)
        .filter((key) => key.startsWith('ORCA_'))
        .sort()
    ).toEqual([
      'ORCA_AGENT_SESSION_ID',
      'ORCA_CLI_COMMAND',
      'ORCA_EVAL_LOG',
      'ORCA_EVAL_STATE',
      'ORCA_STRUCTURED_SESSION',
      'ORCA_USER_DATA_PATH'
    ])
  })

  it('removes only the transcript folder of a benchmark home', () => {
    expect(agentSessionFolder('/private/var/T/orca-bot-eval-home-Ab12Cd')).toMatch(
      /projects[\\/]-private-var-T-orca-bot-eval-home-Ab12Cd$/
    )
    expect(() => agentSessionFolder('/Users/someone/project')).toThrow('not a benchmark home')
  })

  // Spawns git-core's own `git` by path, which is POSIX-named; the eval itself requires zsh.
  describe.skipIf(process.platform === 'win32')('git under the bot environment', () => {
    let root: string
    let repo: string
    let env: Record<string, string>
    let gitCore: string
    const run = (program: string, args: string[], input?: string) =>
      runProcess({
        program,
        args,
        env,
        ...(input === undefined ? {} : { input }),
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        timeoutMs: 30_000
      })

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'orca-eval-git-net-test-'))
      repo = join(root, 'repo')
      env = childEnv(join(root, 'stand-in'), root)
      gitCore = join(
        (
          await runProcess({
            program: 'git',
            args: ['--exec-path'],
            stdio: ['ignore', 'pipe', 'pipe'],
            timeoutMs: 30_000
          })
        ).stdout.trim(),
        'git'
      )
      await run('git', ['init', '--quiet', repo])
      await writeFile(join(repo, 'a.txt'), 'a')
      await run('git', ['-C', repo, 'add', '.'])
      // Commits need no global config: the environment names the author.
      expect((await run('git', ['-C', repo, 'commit', '-qm', 'a'])).code).toBe(0)
    })

    afterEach(async () => {
      await rm(root, { recursive: true, force: true })
    })

    it('refuses every network push, whichever git runs it and whatever config allows', async () => {
      await run('git', ['-C', repo, 'config', 'protocol.https.allow', 'always'])
      const attempts: string[][] = [
        ['push', 'https://github.com/stablyai/orca.git'],
        ['push', 'git@github.com:stablyai/orca.git'],
        ['-c', 'protocol.allow=always', 'push', 'https://github.com/stablyai/orca.git'],
        ['-c', 'protocol.https.allow=always', 'push', 'https://github.com/stablyai/orca.git']
      ]
      for (const attempt of attempts) {
        for (const git of ['git', gitCore]) {
          const [head, ...rest] = attempt
          const args = ['-C', repo, head!, ...rest, 'HEAD:refs/heads/eval-must-not-exist']
          const pushed = await run(git, args)
          expect(pushed.code, `${git} ${attempt.join(' ')}`).not.toBe(0)
          expect(pushed.stderr, `${git} ${attempt.join(' ')}`).toMatch(
            /transport '(https|ssh)' not allowed/
          )
        }
      }
    })

    it('offers no stored credential', async () => {
      const filled = await run('git', ['credential', 'fill'], 'protocol=https\nhost=github.com\n\n')
      expect(filled.stdout).not.toMatch(/^password=/m)
    })

    it('still clones a local checkout', async () => {
      const cloned = await run('git', ['clone', '--shared', '--quiet', repo, join(root, 'clone')])
      expect(cloned.code).toBe(0)
    })
  })
})
