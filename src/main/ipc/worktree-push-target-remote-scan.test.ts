import {
  SSH_FORK,
  makeExec,
  findRemoteForUrlPerRemote,
  fiftyEightRemotes,
  matrix
} from './worktree-push-target-scan-lookup.test-fixture'
import { countProofWork } from './worktree-push-target-proof-work.test-fixture'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { mergeWorktreeMetaForWrite } from '../persistence/loading-store/worktree-meta-write-normalization'
import { cleanupUnusedWorktreePushTargetRemoteWithExec } from './worktree-push-target-cleanup'
import { reconcileOrphanedPrRemotesWithExec } from './worktree-push-target-reconciliation'
import { migrateForkRemoteRefspecsWithExec } from './worktree-push-target-refspec-migration'
import { fetchForkBranch, runForkNativeAction } from '../git/fork-remote-refspec'
import { resolveConfiguredGitPushTarget } from '../../shared/git-push-target-resolution'
import { readGitRemotePolicy } from '../../shared/git-worktree-admin'
import { createFetchEffectProof } from '../../shared/git-branch-cleanup-fetch'
import { describe, expect, it } from 'vitest'

import { findRemoteForUrl, prepareWorktreePushTargetWithExec } from './worktree-push-target-setup'
import type { GitRemoteExec } from './worktree-push-target-cleanup'
describe('findRemoteForUrl', () => {
  it.each(matrix)('matches the per-remote scan for $name', async ({ remotes, lookupUrl }) => {
    const expected = await findRemoteForUrlPerRemote(makeExec(remotes), '/repo', lookupUrl)
    await expect(findRemoteForUrl(makeExec(remotes), '/repo', lookupUrl)).resolves.toBe(expected)
  })

  it('answers from one subprocess at 58 remotes instead of one per remote', async () => {
    const legacyExec = makeExec(fiftyEightRemotes)
    await findRemoteForUrlPerRemote(legacyExec, '/repo', 'https://github.com/nobody/other.git')
    expect(legacyExec.spawns).toHaveLength(fiftyEightRemotes.length + 1)

    const exec = makeExec(fiftyEightRemotes)
    await findRemoteForUrl(exec, '/repo', 'https://github.com/nobody/other.git')
    expect(exec.spawns).toEqual([['remote', '-v']])
  })

  it('propagates unknown discovery rather than permitting a duplicate', async () => {
    const failing: GitRemoteExec = async () => {
      throw new Error('not a git repository')
    }
    await expect(findRemoteForUrl(failing, '/repo', SSH_FORK)).rejects.toThrow(
      'not a git repository'
    )
  })
})

// Serial real-Git actions across the 58/580 corpora require time for native subprocesses.
it('bounds actual acquisitions, duplicate-domain work and complete allocation at58/580', async () => {
  const measurements = new Map<string, number[]>()
  const inputBytes = new Map<string, number[]>()
  const processCounts = new Map<string, number[]>()
  for (const size of [58, 580]) {
    const scratch = await mkdtemp(join(tmpdir(), 'orca-sta-11914-scale-'))
    const home = join(scratch, 'home')
    await mkdir(home)
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
      ),
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(home, 'empty')
    }
    const execute = promisify(execFile)
    const calls: string[][] = []
    let emitted = 0
    const run: GitRemoteExec = async (args, cwd) => {
      calls.push(args)
      const result = await execute('git', args, { cwd, env })
      emitted += Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)
      return result
    }
    try {
      await run(['init', '-q'], scratch)
      await run(['symbolic-ref', 'HEAD', 'refs/heads/main'], scratch)
      await run(
        [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.test',
          '-c',
          'commit.gpgSign=false',
          'commit',
          '--allow-empty',
          '-qm',
          'seed'
        ],
        scratch
      )
      const oid = (await run(['rev-parse', 'HEAD'], scratch)).stdout.trim()
      await run(['branch', 'topic0'], scratch)
      const fork = join(scratch, 'fork.git')
      await run(['clone', '--bare', '-q', scratch, fork], scratch)
      await run(['worktree', 'add', '-qb', 'keeper', join(scratch, 'keeper')], scratch)
      await mkdir(join(scratch, '.git', 'remotes'))
      await writeFile(
        join(scratch, '.git', 'remotes', '.proof'),
        `URL: ${fork}\nPull: refs/heads/topic0\n`
      )
      const configPath = join(scratch, '.git', 'config'),
        baseline = await readFile(configPath, 'utf8')
      const remotes = Array.from({ length: size }, (_, i) => `pr-scale-${i}`)
      for (const corpus of [
        'duplicate-urls',
        'duplicate-bases',
        'unknown-domains',
        'duplicate-stock',
        'positive-stock',
        'nested-stock',
        'cross-owner-same',
        'cross-owner-different',
        'cross-owner-unknown'
      ]) {
        const oneOwner = ['duplicate-stock', 'positive-stock', 'nested-stock'].includes(corpus)
        const owners = oneOwner ? [remotes[0]] : remotes
        const sections = owners
          .map((name, i) => {
            const cross = corpus.startsWith('cross-owner')
            const endpoint =
              corpus === 'cross-owner-unknown' && i
                ? ''
                : ` url = ${corpus === 'cross-owner-different' && i ? '/different-repository' : fork}\n`
            const maps = oneOwner
              ? Array.from(
                  { length: size },
                  (_, n) =>
                    `+refs/heads/${corpus === 'positive-stock' ? '*' : corpus === 'nested-stock' ? `${'t'.repeat(n + 1)}*` : 'topic0*'}:refs/remotes/${name}/${corpus === 'positive-stock' ? '*' : corpus === 'nested-stock' ? `${'t'.repeat(n + 1)}*` : 'topic0*'}`
                )
              : [
                  `+refs/heads/topic0*:${corpus === 'duplicate-bases' ? 'refs/private/' : `refs/remotes/${cross ? remotes[0] : name}/`}topic0*`
                ]
            return `[remote "${name}"]\n${endpoint} orca-created = true\n${maps.map((spec) => ` fetch = ${spec}\n`).join('')}`
          })
          .join('')
        await writeFile(
          configPath,
          baseline +
            sections +
            (corpus === 'unknown-domains'
              ? remotes
                  .map(
                    (_, i) =>
                      `[remote "unresolved-${i}"]\n url = ${fork}\n fetch = refs/heads/topic0\n`
                  )
                  .join('')
              : '') +
            (['duplicate-stock', 'nested-stock'].includes(corpus)
              ? `[remote]\n pushDefault = ${remotes[0]}\n`
              : '')
        )
        const rows = Object.fromEntries(
          Array.from(
            { length: corpus === 'duplicate-bases' ? size : oneOwner ? 1 : size * 3 },
            (_, i) => [
              `repo::/saved-${i}`,
              mergeWorktreeMetaForWrite(
                undefined,
                corpus === 'duplicate-bases'
                  ? { baseRef: 'refs/private/main' }
                  : {
                      preserveBranchOnDelete: true,
                      pushTarget: {
                        remoteName: owners[i % owners.length],
                        remoteUrl: fork,
                        branchName: 'topic0',
                        remoteCreated: false
                      }
                    }
              )
            ]
          )
        )
        let metadataReads = 0
        const store = {
          getAllWorktreeMeta: () => {
            metadataReads += 1
            return rows
          }
        }
        for (const operation of ['cleanup', 'sweep', 'migration']) {
          for (const denied of [false, true]) {
            if (corpus === 'positive-stock') {
              await writeFile(configPath, baseline + sections)
              await run(['update-ref', `refs/remotes/${remotes[0]}/topic0`, oid], scratch)
              await run(['update-ref', `refs/remotes/${remotes[0]}/obsolete`, oid], scratch)
            }
            const counter = countProofWork()
            const checked: GitRemoteExec = (args, cwd) => {
              if (denied && args.includes('--file') && args.includes('config')) {
                calls.push(args)
                return Promise.reject(new Error('proof denied'))
              }
              return run(args, cwd)
            }
            calls.length = 0
            metadataReads = 0
            emitted = 0
            try {
              if (operation === 'cleanup') {
                await cleanupUnusedWorktreePushTargetRemoteWithExec(
                  scratch,
                  'repo::/removed',
                  { remoteName: remotes[0], remoteUrl: fork, branchName: 'topic0' },
                  store,
                  checked
                )
              } else if (operation === 'sweep') {
                expect(
                  await reconcileOrphanedPrRemotesWithExec(
                    scratch,
                    'repo',
                    store,
                    checked,
                    async () => []
                  )
                ).toEqual([])
              } else {
                expect(
                  await migrateForkRemoteRefspecsWithExec(scratch, 'repo', store, checked)
                ).toEqual(corpus === 'positive-stock' && !denied ? [remotes[0]] : [])
              }
            } finally {
              counter.restore()
            }
            const positive = corpus === 'positive-stock' && operation === 'migration' && !denied
            expect(calls.length).toBe(denied ? 3 : positive ? 33 : 15)
            expect(calls.filter((args) => args.includes('-v'))).toHaveLength(
              denied ? 0 : positive ? 4 : 2
            )
            expect(calls.filter((args) => args.includes('get-url'))).toHaveLength(
              denied ? 0 : positive ? 8 : 4
            )
            expect(
              calls
                .filter((args) => args.includes('get-url'))
                .every((args) => args.at(-1) === '.proof')
            ).toBe(true)
            if (denied) {
              expect(metadataReads).toBe(0)
            } else {
              expect(metadataReads).toBeGreaterThanOrEqual(1)
            }
            if (!positive) {
              expect(
                calls.some(
                  (args) =>
                    args.includes('--unset-all') ||
                    args.includes('--add') ||
                    args.includes('remove') ||
                    args[0] === 'update-ref'
                )
              ).toBe(false)
            }
            const work = counter.value()
            if (corpus === 'duplicate-urls' && operation === 'sweep' && !denied) {
              console.info('FP1 duplicate-urls/sweep/false', {
                size,
                mapEntryVisits: counter.mapEntryVisits(),
                work
              })
              expect(counter.mapEntryVisits()).toBeLessThan(1000 * size)
            }
            expect(work).toBeLessThan(1000 * (emitted + JSON.stringify(rows).length + 1))
            const key = `${corpus}/${operation}/${denied}`
            const values = measurements.get(key) ?? []
            values.push(work)
            measurements.set(key, values)
            const bytes = inputBytes.get(key) ?? []
            bytes.push(emitted + JSON.stringify(rows).length)
            inputBytes.set(key, bytes)
          }
        }
      }
      for (const kind of ['push', 'pull'] as const) {
        const specs = Array.from({ length: size }, () => '+refs/heads/*:refs/remotes/native/*')
        specs.push(
          '+refs/heads/*:refs/secondary/*',
          '^refs/heads/topic0',
          '+refs/tags/*:refs/tags/*'
        )
        const rows = specs.map((spec) => ({ name: 'native', spec, url: fork }))
        const counter = countProofWork()
        let accepted: boolean
        try {
          accepted = createFetchEffectProof(rows, [], (a, b) => a === b).operation(
            fork,
            specs,
            'refs/heads/topic0',
            kind,
            true
          )
        } finally {
          counter.restore()
        }
        expect(accepted).toBe(true)
        const values = measurements.get(`native-${kind}`) ?? []
        values.push(counter.value())
        measurements.set(`native-${kind}`, values)
        expect(counter.value()).toBeLessThan(10000 * size)
      }
      const withInput = async (args: string[], input: string, cwd = scratch) => {
        const pending = execute('git', args, { cwd, env })
        if (!pending.child.stdin) {
          throw new Error('Missing fixture Git stdin')
        }
        pending.child.stdin.end(input)
        await pending
      }
      await withInput(
        ['fast-import', '--quiet'],
        Array.from({ length: size }, (_, i) => {
          const message = `follow${i}`
          return `tag v${i}\nfrom ${oid}\ntagger Test <test@example.test> 1 +0000\ndata ${Buffer.byteLength(message)}\n${message}\n`
        }).join('')
      )
      const tagRows = (
        await run(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/tags/'], scratch)
      ).stdout
        .trim()
        .split('\n')
      expect(tagRows).toHaveLength(size)
      expect(new Set(tagRows.map((row) => row.split(' ')[1])).size).toBe(size)
      expect(
        (await run(['for-each-ref', '--format=%(objecttype)', 'refs/tags/'], scratch)).stdout
          .trim()
          .split('\n')
      ).toEqual(Array(size).fill('tag'))
      const tagRefs = tagRows.map((row) => row.split(' ')[0])
      const clearTags = (cwd: string, prefix: string) =>
        withInput(
          ['update-ref', '--stdin'],
          tagRefs.map((ref) => `delete ${ref.replace('refs/tags/', prefix)}\n`).join(''),
          cwd
        )
      const expectTags = async (cwd: string, prefix: string, rows = tagRows) => {
        expect(
          (await run(['for-each-ref', '--format=%(refname) %(objectname)', prefix], cwd)).stdout
            .trim()
            .split('\n')
        ).toEqual(rows.map((row) => row.replace('refs/tags/', prefix)))
      }
      const expectFollowed = (output: string) => {
        const followed = output.split('\n').flatMap((line) => {
          const row = /\[new tag\]\s+(v\d+) -> (v\d+)(?:\s|$)/.exec(line)
          return row && row[1] === row[2] ? [row[1]] : []
        })
        expect(followed.sort()).toEqual(tagRefs.map((ref) => ref.slice('refs/tags/'.length)).sort())
      }
      const tagSpecs = Array.from(
        { length: size },
        (_, i) => `+refs/tags/v${i}:refs/tag-cache/v${i}`
      )
      await writeFile(
        configPath,
        `${`${baseline}[remote "native"]\n url = ${fork}\n fetch = +refs/heads/*:refs/remotes/native/*\n${tagSpecs.map((spec) => ` fetch = ${spec}\n`).join('')}`}[push]
 followTags = true
`
      )
      await run(
        [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.test',
          '-c',
          'commit.gpgSign=false',
          'commit',
          '--allow-empty',
          '-qm',
          'push'
        ],
        scratch
      )
      const target = { remoteName: 'native', remoteUrl: fork, branchName: 'topic0' }
      for (const entrance of ['prepare', 'push', 'pull', 'generic']) {
        if (['push', 'pull', 'generic'].includes(entrance)) {
          await clearTags(scratch, 'refs/tag-cache/')
        }
        if (['push', 'generic'].includes(entrance)) {
          await clearTags(fork, 'refs/tags/')
        }
        if (entrance === 'generic') {
          const branch = (await run(['symbolic-ref', '--short', 'HEAD'], scratch)).stdout.trim()
          await run(['config', `branch.${branch}.remote`, `file://${fork}`], scratch)
          await run(['config', 'remote.native.url', `file://${fork}`], scratch)
        }
        const borrowed = (await readFile(configPath, 'utf8')).match(
          /\[remote "native"\][\s\S]*?(?=\n\[|$)/
        )?.[0]
        expect(borrowed).toBeDefined()
        let followed = ''
        calls.length = 0
        emitted = 0
        const counter = countProofWork()
        try {
          if (entrance === 'prepare') {
            expect(
              (await prepareWorktreePushTargetWithExec(run, scratch, target, '', true)).remoteName
            ).toBe('native')
          } else if (entrance === 'push') {
            followed =
              (
                await runForkNativeAction(run, scratch, target, 'push', () =>
                  run(['push', '--set-upstream', 'native', 'HEAD:topic0'], scratch)
                )
              ).stderr ?? ''
          } else if (entrance === 'pull') {
            await runForkNativeAction(run, scratch, target, 'pull', () =>
              run(['pull', '--ff-only', 'native'], scratch)
            )
          } else {
            const resolved = await resolveConfiguredGitPushTarget((args) => run(args, scratch), {
              cwd: scratch,
              exec: run
            })
            expect(resolved?.remote).toBe('native')
            if (!resolved) {
              throw new Error('Missing generic destination')
            }
            followed =
              (await run(['push', '--set-upstream', resolved.remote, resolved.refspec], scratch))
                .stderr ?? ''
          }
        } finally {
          counter.restore()
        }
        const key = `distinct-native-${entrance}`,
          values = measurements.get(key) ?? []
        values.push(counter.value())
        measurements.set(key, values)
        const bytes = inputBytes.get(key) ?? []
        bytes.push(emitted)
        inputBytes.set(key, bytes)
        const processes = processCounts.get(key) ?? []
        processes.push(calls.length)
        processCounts.set(key, processes)
        expect(calls.filter((args) => args.includes('-v'))).toHaveLength(
          entrance === 'prepare' ? 4 : 2
        )
        expect(calls.filter((args) => args.includes('get-url'))).toHaveLength(
          entrance === 'prepare' ? 8 : 4
        )
        expect(emitted).toBeLessThan(1500 * size)
        expect(
          (await readFile(configPath, 'utf8')).match(/\[remote "native"\][\s\S]*?(?=\n\[|$)/)?.[0]
        ).toBe(borrowed)
        expect((await run(['config', '--get', 'push.followTags'], scratch)).stdout).toBe('true\n')
        if (entrance !== 'prepare') {
          await expectTags(fork, 'refs/tags/')
          await expectTags(scratch, 'refs/tag-cache/')
          expect((await run(['rev-parse', 'refs/remotes/native/topic0'], scratch)).stdout).toBe(
            (await run(['rev-parse', 'HEAD'], scratch)).stdout
          )
          expect(
            (await run(['rev-parse', '--symbolic-full-name', 'HEAD@{u}'], scratch)).stdout
          ).toBe('refs/remotes/native/topic0\n')
          if (entrance !== 'pull') {
            expectFollowed(followed)
          }
        }
      }
      expect((await run(['rev-parse', 'refs/heads/topic0'], fork)).stdout).toBe(
        (await run(['rev-parse', 'HEAD'], scratch)).stdout
      )
      expect((await run(['rev-parse', 'refs/tags/v1'], fork)).stdout).toBe(
        (await run(['rev-parse', 'refs/tags/v1'], scratch)).stdout
      )
      expect((await run(['rev-parse', 'HEAD@{u}'], scratch)).stdout).toBe(
        (await run(['rev-parse', 'HEAD'], scratch)).stdout
      )
      for (const corpus of ['distinct', 'duplicate']) {
        const legacyFile = join(scratch, '.git', 'remotes', '.proof'),
          legacyUrl = `file://${fork}`
        const legacy = `URL: ${legacyUrl}\nPull: +refs/heads/*:refs/review/manual/*\n${Array.from(
          { length: size },
          (_, i) =>
            `Pull: +refs/tags/v${corpus === 'distinct' ? i : 1}:refs/tag-cache/v${corpus === 'distinct' ? i : 1}\n`
        ).join('')}`
        await writeFile(legacyFile, legacy)
        await writeFile(
          configPath,
          `${baseline}[push]
 followTags = true
`
        )
        await run(['update-ref', '-d', 'refs/review/manual/topic0'], scratch)
        const wanted = { remoteName: '.proof', remoteUrl: legacyUrl, branchName: 'topic0' }
        const current = (await run(['symbolic-ref', '--short', 'HEAD'], scratch)).stdout.trim()
        for (const entrance of [
          'prepare',
          'push',
          'pull',
          'fetch',
          'reader',
          'generic',
          'cleanup',
          'sweep',
          'migration'
        ]) {
          const stock = `${`[remote "pr-stock"]
 url = ${fork}`}
 orca-created = true
 fetch = +refs/heads/*:refs/remotes/pr-stock/*
`
          if (['cleanup', 'sweep', 'migration'].includes(entrance)) {
            await writeFile(configPath, baseline + stock)
            await run(['update-ref', 'refs/remotes/pr-stock/obsolete', oid], scratch)
          }
          if (['push', 'pull', 'generic'].includes(entrance)) {
            await clearTags(scratch, 'refs/tag-cache/')
          }
          if (['push', 'generic'].includes(entrance)) {
            await clearTags(fork, 'refs/tags/')
          }
          let followed = ''
          const counter = countProofWork()
          calls.length = 0
          emitted = 0
          try {
            if (entrance === 'prepare') {
              expect(
                (await prepareWorktreePushTargetWithExec(run, scratch, wanted, '', true)).remoteName
              ).toBe('.proof')
            } else if (entrance === 'push') {
              followed =
                (
                  await runForkNativeAction(run, scratch, wanted, 'push', () =>
                    run(['push', '--set-upstream', '.proof', 'HEAD:topic0'], scratch)
                  )
                ).stderr ?? ''
            } else if (entrance === 'pull') {
              await runForkNativeAction(run, scratch, wanted, 'pull', () =>
                run(['pull', '--ff-only', '.proof'], scratch)
              )
            } else if (entrance === 'fetch') {
              await fetchForkBranch(run, scratch, '.proof', 'topic0', '', legacyUrl)
            } else if (entrance === 'reader') {
              expect(
                (await readGitRemotePolicy(run, scratch, '.proof')).fields.get('fetch')
              ).toHaveLength(size + 1)
            } else if (entrance === 'generic') {
              await run(['config', `branch.${current}.remote`, legacyUrl], scratch)
              const resolved = await resolveConfiguredGitPushTarget((args) => run(args, scratch), {
                cwd: scratch,
                exec: run
              })
              expect(resolved?.remote).toBe('.proof')
              if (!resolved) {
                throw new Error('Missing native legacy destination')
              }
              followed =
                (await run(['push', '--set-upstream', resolved.remote, resolved.refspec], scratch))
                  .stderr ?? ''
            } else if (entrance === 'cleanup') {
              await cleanupUnusedWorktreePushTargetRemoteWithExec(
                scratch,
                'repo::/removed',
                { remoteName: 'pr-stock', remoteUrl: fork, branchName: 'topic0' },
                { getAllWorktreeMeta: () => ({}) },
                run
              )
            } else if (entrance === 'sweep') {
              expect(
                await reconcileOrphanedPrRemotesWithExec(
                  scratch,
                  'repo',
                  { getAllWorktreeMeta: () => ({}) },
                  run,
                  async () => []
                )
              ).toEqual(['pr-stock'])
            } else {
              expect(
                await migrateForkRemoteRefspecsWithExec(
                  scratch,
                  'repo',
                  { getAllWorktreeMeta: () => ({}) },
                  run
                )
              ).toEqual(['pr-stock'])
            }
          } finally {
            counter.restore()
          }
          const key = `legacy-${corpus}-${entrance}`,
            work = counter.value()
          const values = measurements.get(key) ?? []
          values.push(work)
          measurements.set(key, values)
          const bytes = inputBytes.get(key) ?? []
          bytes.push(emitted + Buffer.byteLength(legacy) * 2)
          inputBytes.set(key, bytes)
          const processes = processCounts.get(key) ?? []
          processes.push(calls.length)
          processCounts.set(key, processes)
          expect(calls.filter((args) => args.includes('-v'))).toHaveLength(
            entrance === 'reader'
              ? 0
              : ['prepare', 'cleanup', 'sweep', 'migration'].includes(entrance)
                ? 4
                : 2
          )
          expect(calls.filter((args) => args.includes('get-url'))).toHaveLength(
            entrance === 'reader'
              ? 2
              : ['prepare', 'cleanup', 'sweep', 'migration'].includes(entrance)
                ? 8
                : 4
          )
          expect(await readFile(legacyFile, 'utf8')).toBe(legacy)
          if (['cleanup', 'sweep'].includes(entrance)) {
            await expect(run(['remote', 'get-url', 'pr-stock'], scratch)).rejects.toThrow()
          }
          if (entrance === 'migration') {
            await expect(
              run(['config', '--get-all', 'remote.pr-stock.fetch'], scratch)
            ).rejects.toThrow()
          }
          if (['push', 'pull', 'fetch', 'generic'].includes(entrance)) {
            expect((await run(['config', '--get', 'push.followTags'], scratch)).stdout).toBe(
              'true\n'
            )
            expect((await run(['rev-parse', 'refs/review/manual/topic0'], scratch)).stdout).toBe(
              (await run(['rev-parse', 'refs/heads/topic0'], fork)).stdout
            )
            await expectTags(fork, 'refs/tags/')
            await expectTags(
              scratch,
              'refs/tag-cache/',
              corpus === 'distinct'
                ? tagRows
                : tagRows.filter((row) => row.startsWith('refs/tags/v1 '))
            )
            expect(
              (await run(['rev-parse', '--symbolic-full-name', 'HEAD@{u}'], scratch)).stdout
            ).toBe('refs/review/manual/topic0\n')
            expect((await run(['rev-parse', 'HEAD@{u}'], scratch)).stdout).toBe(
              (await run(['rev-parse', 'HEAD'], scratch)).stdout
            )
            if (entrance === 'push' || entrance === 'generic') {
              expectFollowed(followed)
            }
          }
        }
      }
      await writeFile(
        configPath,
        `${
          baseline +
          remotes
            .map(
              (name) =>
                `[remote "${name}"]\n url = ${fork}\n fetch = +refs/heads/*:refs/private/*\n`
            )
            .join('')
        }[remote "foreign"]
 url = /different-repository
 fetch = +refs/heads/secret:refs/private/topic0
`
      )
      calls.length = 0
      const counter = countProofWork()
      let result
      try {
        result = await prepareWorktreePushTargetWithExec(run, scratch, {
          remoteName: 'requested',
          remoteUrl: fork,
          branchName: 'topic0'
        })
      } finally {
        counter.restore()
      }
      const work = counter.value()
      expect(work).toBeLessThan(100000 * size)
      const values = measurements.get('dense-allocation') ?? []
      values.push(work)
      measurements.set('dense-allocation', values)
      expect(calls.filter((args) => args.includes('-v'))).toHaveLength(4)
      expect(result.remoteName).toBe('requested')
      expect(calls.filter((args) => args[0] === 'remote' && args[1] === 'add')).toHaveLength(1)
      expect(calls.filter((args) => args[0] === 'fetch')).toHaveLength(1)
      expect((await run(['rev-parse', 'refs/remotes/requested/topic0'], scratch)).stdout).toBe(
        (await run(['rev-parse', 'refs/heads/topic0'], fork)).stdout
      )
      expect((await run(['config', '--get', 'remote.pr-scale-0.fetch'], scratch)).stdout).toBe(
        '+refs/heads/*:refs/private/*\n'
      )
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }
  for (const [key, counts] of processCounts) {
    expect(counts[1], key).toBe(counts[0])
  }
  for (const [key, values] of measurements) {
    const bytes = inputBytes.get(key)
    const growth = bytes ? Math.max(12, (bytes[1] / bytes[0]) * 1.5) : 12
    expect(values[1], key).toBeLessThanOrEqual(values[0] * growth)
  }
}, 120_000)
